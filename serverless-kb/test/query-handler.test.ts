import './env/query-env';
import { BedrockAgentRuntimeClient, RetrieveAndGenerateCommand, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { PROMPT_TEMPLATE } from '../src/core/retrieval';
import { handler } from '../src/handlers/query';

const bedrock = mockClient(BedrockAgentRuntimeClient);
const eventbridge = mockClient(EventBridgeClient);
const context = { awsRequestId: 'req-1', functionName: 'query' } as unknown as Context;

const ALL_SCOPES = 'kb-api/retrieve kb-api/ask kb-api/group:general kb-api/group:finance';

function event(resource: string, body: unknown, opts: { scope?: string; headers?: Record<string, string>; method?: string } = {}): APIGatewayProxyEvent {
  return {
    resource,
    httpMethod: opts.method ?? 'POST',
    headers: opts.headers ?? {},
    body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { requestId: 'api-req-1', authorizer: { claims: { scope: opts.scope ?? ALL_SCOPES, client_id: 'client-abc' } } },
  } as unknown as APIGatewayProxyEvent;
}

const sampleResult = (text = 'Chunk text', score = 0.87, key = 'documents/policy.pdf') => ({
  content: { text, type: 'TEXT' as const },
  score,
  location: { type: 'S3' as const, s3Location: { uri: `s3://secret-bucket-name/${key}` } },
  metadata: {
    'x-amz-bedrock-kb-source-uri': `s3://secret-bucket-name/${key}`,
    'x-amz-bedrock-kb-chunk-id': 'chunk-1',
    'x-amz-bedrock-kb-data-source-id': 'DS1',
    department: 'finance',
    access_group: 'finance',
  },
});

beforeEach(() => {
  bedrock.reset();
  eventbridge.reset();
  eventbridge.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'e1' }] });
});

function auditDetail(): Record<string, unknown> {
  const input = eventbridge.commandCalls(PutEventsCommand)[0]!.args[0].input;
  return JSON.parse(input.Entries![0]!.Detail!) as Record<string, unknown>;
}

describe('POST /retrieve', () => {
  test('returns references without leaking the bucket name or system metadata', async () => {
    bedrock.on(RetrieveCommand).resolves({ retrievalResults: [sampleResult()] });
    const res = await handler(event('/retrieve', { query: 'travel policy' }), context);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('secret-bucket-name');
    expect(res.body).not.toContain('x-amz-bedrock-kb');
    expect(JSON.parse(res.body)).toEqual({
      references: [
        { text: 'Chunk text', score: 0.87, source: { key: 'documents/policy.pdf' }, chunkId: 'chunk-1', metadata: { department: 'finance', access_group: 'finance' } },
      ],
      usage: { estimatedTokens: 3, truncated: false },
    });
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  });

  test('always scopes retrieval to the token access groups, ANDed with caller filters', async () => {
    bedrock.on(RetrieveCommand).resolves({ retrievalResults: [] });
    await handler(event('/retrieve', { query: 'q', maxResults: 3, filter: { department: 'hr', doc_type: ['policy', 'faq'] } }), context);
    expect(bedrock).toHaveReceivedCommandWith(RetrieveCommand, {
      knowledgeBaseId: 'KBTEST1234',
      retrievalQuery: { text: 'q' },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: 3,
          filter: {
            andAll: [
              { in: { key: 'access_group', value: ['general', 'finance'] } },
              { equals: { key: 'department', value: 'hr' } },
              { in: { key: 'doc_type', value: ['policy', 'faq'] } },
            ],
          },
        },
      },
    });
  });

  test('X-Access-Groups narrows but can never widen the token ceiling', async () => {
    bedrock.on(RetrieveCommand).resolves({ retrievalResults: [] });
    await handler(event('/retrieve', { query: 'q' }, { headers: { 'X-Access-Groups': 'finance,hr' } }), context);
    expect(bedrock).toHaveReceivedCommandWith(RetrieveCommand, {
      retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 5, filter: { in: { key: 'access_group', value: ['finance'] } } } },
    });
  });

  test('delegating (gateway) tokens must name the user and narrow the groups', async () => {
    bedrock.on(RetrieveCommand).resolves({ retrievalResults: [] });
    const scope = `${ALL_SCOPES} kb-api/delegated`;
    expect((await handler(event('/retrieve', { query: 'q' }, { scope }), context)).statusCode).toBe(400);
    expect((await handler(event('/retrieve', { query: 'q' }, { scope, headers: { 'X-On-Behalf-Of': 'user-1' } }), context)).statusCode).toBe(400);
    expect(bedrock).not.toHaveReceivedAnyCommand();
    const ok = await handler(event('/retrieve', { query: 'q' }, { scope, headers: { 'X-On-Behalf-Of': 'user-1', 'X-Access-Groups': 'general' } }), context);
    expect(ok.statusCode).toBe(200);
    expect(auditDetail()).toMatchObject({ delegated: true, onBehalfOf: 'user-1', accessGroups: ['general'] });
  });

  test('no access groups (token or after narrowing) is forbidden and calls nothing', async () => {
    const noGroups = await handler(event('/retrieve', { query: 'q' }, { scope: 'kb-api/retrieve' }), context);
    expect(noGroups.statusCode).toBe(403);
    const narrowedAway = await handler(event('/retrieve', { query: 'q' }, { headers: { 'x-access-groups': 'hr' } }), context);
    expect(narrowedAway.statusCode).toBe(403);
    expect(bedrock).not.toHaveReceivedAnyCommand();
  });

  test('a filter on the access key itself is rejected', async () => {
    const res = await handler(event('/retrieve', { query: 'q', filter: { access_group: 'hr' } }), context);
    expect(res.statusCode).toBe(400);
    expect(bedrock).not.toHaveReceivedAnyCommand();
  });

  test('trims results to the token budget, highest score first', async () => {
    bedrock.on(RetrieveCommand).resolves({
      retrievalResults: [sampleResult('a'.repeat(400), 0.5, 'documents/low.pdf'), sampleResult('b'.repeat(400), 0.9, 'documents/high.pdf')],
    });
    const res = await handler(event('/retrieve', { query: 'q', maxTokens: 150 }), context);
    const body = JSON.parse(res.body);
    expect(body.references.map((r: { source: { key: string } }) => r.source.key)).toEqual(['documents/high.pdf']);
    expect(body.usage).toEqual({ estimatedTokens: 100, truncated: true });
  });

  test('records a ContextServed audit event with identifiers only', async () => {
    bedrock.on(RetrieveCommand).resolves({ retrievalResults: [sampleResult()] });
    await handler(
      event('/retrieve', { query: 'travel policy' }, { headers: { 'X-On-Behalf-Of': 'user-42', 'X-Agent-Id': 'planner', 'X-Run-Id': 'run-7', 'X-Trace-Id': 'trace-1' } }),
      context,
    );
    const call = eventbridge.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!;
    expect(call).toMatchObject({ EventBusName: 'audit-bus', Source: 'kb.retrieval', DetailType: 'ContextServed' });
    const detail = auditDetail();
    expect(detail).toMatchObject({
      requestId: 'api-req-1',
      channel: 'rest',
      operation: 'retrieve',
      clientId: 'client-abc',
      onBehalfOf: 'user-42',
      agentId: 'planner',
      runId: 'run-7',
      traceId: 'trace-1',
      accessGroups: ['general', 'finance'],
      queryLength: 13,
      references: [{ sourceKey: 'documents/policy.pdf', chunkId: 'chunk-1', score: 0.87 }],
    });
    expect(detail.queryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(detail)).not.toContain('travel policy');
    expect(JSON.stringify(detail)).not.toContain('Chunk text');
  });

  test('fails closed when the audit event cannot be recorded', async () => {
    bedrock.on(RetrieveCommand).resolves({ retrievalResults: [sampleResult()] });
    eventbridge.on(PutEventsCommand).resolves({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] });
    const res = await handler(event('/retrieve', { query: 'q' }), context);
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('Chunk text');
  });

  test.each([
    ['missing body', undefined],
    ['invalid JSON', '{nope'],
    ['empty query', { query: '   ' }],
    ['query too long', { query: 'x'.repeat(101) }],
    ['maxResults above cap', { query: 'q', maxResults: 11 }],
    ['maxTokens above budget', { query: 'q', maxTokens: 4001 }],
    ['unknown field', { query: 'q', sessionId: 'abc' }],
    ['filter key not allowed', { query: 'q', filter: { owner: 'me' } }],
    ['empty filter', { query: 'q', filter: {} }],
  ])('rejects %s with 400 and calls nothing', async (_name, body) => {
    const res = await handler(event('/retrieve', body), context);
    expect(res.statusCode).toBe(400);
    expect(bedrock).not.toHaveReceivedAnyCommand();
  });

  test('rejects oversized bodies with 413', async () => {
    const res = await handler(event('/retrieve', { query: 'q', pad: 'x'.repeat(20_000) }), context);
    expect(res.statusCode).toBe(413);
  });

  test.each([
    ['X-On-Behalf-Of', 'bad value with spaces'],
    ['X-Access-Groups', 'Finance!'],
    ['X-Run-Id', 'x'.repeat(200)],
  ])('rejects a malformed %s header', async (name, value) => {
    const res = await handler(event('/retrieve', { query: 'q' }, { headers: { [name]: value } }), context);
    expect(res.statusCode).toBe(400);
  });

  test('error messages do not echo input values', async () => {
    const res = await handler(event('/retrieve', { query: 'q', filter: { '<script>': 'x' } }), context);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('<script>');
  });

  test('rejects callers without the retrieve scope (defence in depth)', async () => {
    const res = await handler(event('/retrieve', { query: 'q' }, { scope: 'kb-api/ask kb-api/group:general' }), context);
    expect(res.statusCode).toBe(403);
    expect(bedrock).not.toHaveReceivedAnyCommand();
  });

  test('does not accept scopes from another resource server', async () => {
    const res = await handler(event('/retrieve', { query: 'q' }, { scope: 'other-api/retrieve other-api/group:general' }), context);
    expect(res.statusCode).toBe(403);
  });

  test('maps throttling to 429 and hides internal errors', async () => {
    bedrock.on(RetrieveCommand).rejectsOnce(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    expect((await handler(event('/retrieve', { query: 'q' }), context)).statusCode).toBe(429);

    bedrock.on(RetrieveCommand).rejectsOnce(Object.assign(new Error('User: arn:aws:iam::123:role/x is not authorized'), { name: 'AccessDeniedException' }));
    const res = await handler(event('/retrieve', { query: 'q' }), context);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('arn:aws');
  });

  test('unknown routes return 404', async () => {
    expect((await handler(event('/admin', { query: 'q' }), context)).statusCode).toBe(404);
  });
});

describe('POST /ask', () => {
  test('uses the hardened prompt, scopes retrieval, returns answer with citations and audits it', async () => {
    bedrock.on(RetrieveAndGenerateCommand).resolves({ output: { text: 'The answer.' }, citations: [{ retrievedReferences: [sampleResult()] }] });
    const res = await handler(event('/ask', { query: 'what is the policy?' }), context);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.answer).toBe('The answer.');
    expect(body.references[0].source).toEqual({ key: 'documents/policy.pdf' });
    const input = bedrock.commandCalls(RetrieveAndGenerateCommand)[0]!.args[0].input;
    expect(input.sessionId).toBeUndefined();
    const kbConfig = input.retrieveAndGenerateConfiguration!.knowledgeBaseConfiguration!;
    expect(kbConfig.generationConfiguration).toEqual({ promptTemplate: { textPromptTemplate: PROMPT_TEMPLATE } });
    expect(kbConfig.retrievalConfiguration!.vectorSearchConfiguration!.filter).toEqual({ in: { key: 'access_group', value: ['general', 'finance'] } });
    expect(auditDetail()).toMatchObject({ operation: 'ask', answerReturned: true });
    expect(PROMPT_TEMPLATE).toContain('$search_results$');
  });
});

describe('POST /mcp', () => {
  const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
  const call = async (body: unknown, opts: { scope?: string; headers?: Record<string, string> } = {}) => {
    const res = await handler(event('/mcp', body, opts), context);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

  test('initialize negotiates a supported protocol version', async () => {
    const { status, body } = await call(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
    expect(status).toBe(200);
    expect(body.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'kb-retrieval' } });
    const latest = await call(rpc('initialize', { protocolVersion: '1999-01-01' }));
    expect(latest.body.result.protocolVersion).toBe('2025-06-18');
  });

  test('notifications get 202 with no body', async () => {
    const { status, body } = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(status).toBe(202);
    expect(body).toBeUndefined();
  });

  test('tools/list only shows tools the token allows', async () => {
    const all = await call(rpc('tools/list'));
    expect(all.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['search_documents', 'ask_documents']);
    const tool = all.body.result.tools[0];
    expect(tool.inputSchema).toMatchObject({ type: 'object', required: ['query'], additionalProperties: false });
    expect(tool.inputSchema.properties.filter.properties).toHaveProperty('department');
    const retrieveOnly = await call(rpc('tools/list'), { scope: 'kb-api/retrieve kb-api/group:general' });
    expect(retrieveOnly.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['search_documents']);
  });

  test('tools/call search_documents is scoped, budgeted and audited like REST', async () => {
    bedrock.on(RetrieveCommand).resolves({ retrievalResults: [sampleResult()] });
    const { status, body } = await call(rpc('tools/call', { name: 'search_documents', arguments: { query: 'policy', maxTokens: 100 } }), {
      headers: { 'X-Access-Groups': 'general', 'X-On-Behalf-Of': 'user-42' },
    });
    expect(status).toBe(200);
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.references[0].source.key).toBe('documents/policy.pdf');
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
    expect(bedrock).toHaveReceivedCommandWith(RetrieveCommand, {
      retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 5, filter: { in: { key: 'access_group', value: ['general'] } } } },
    });
    expect(auditDetail()).toMatchObject({ channel: 'mcp', onBehalfOf: 'user-42', accessGroups: ['general'] });
  });

  test('tool argument errors are tool results, not protocol errors', async () => {
    const { body } = await call(rpc('tools/call', { name: 'search_documents', arguments: { query: '' } }));
    expect(body.result.isError).toBe(true);
    expect(bedrock).not.toHaveReceivedAnyCommand();
  });

  test('unauthorised or unknown tools are refused', async () => {
    const { body } = await call(rpc('tools/call', { name: 'ask_documents', arguments: { query: 'q' } }), { scope: 'kb-api/retrieve kb-api/group:general' });
    expect(body.result.isError).toBe(true);
    expect(bedrock).not.toHaveReceivedAnyCommand();
  });

  test('throttling becomes a tool error', async () => {
    bedrock.on(RetrieveCommand).rejects(Object.assign(new Error('slow'), { name: 'ThrottlingException' }));
    const { body } = await call(rpc('tools/call', { name: 'search_documents', arguments: { query: 'q' } }));
    expect(body.result).toMatchObject({ isError: true, content: [{ text: 'Too many requests' }] });
  });

  test('protocol errors: parse error, invalid request, batch, unknown method', async () => {
    expect((await call('{nope')).body.error.code).toBe(-32700);
    expect((await call({ id: 1, method: 'ping' })).body.error.code).toBe(-32600);
    expect((await call([rpc('ping')])).body.error.code).toBe(-32600);
    expect((await call(rpc('resources/list'))).body.error.code).toBe(-32601);
    expect((await call(rpc('ping'))).body.result).toEqual({});
  });

  test('browser-originated requests are refused', async () => {
    const { status } = await call(rpc('ping'), { headers: { origin: 'https://evil.example' } });
    expect(status).toBe(403);
  });

  test('GET returns 405 (no SSE stream)', async () => {
    const res = await handler(event('/mcp', undefined, { method: 'GET' }), context);
    expect(res.statusCode).toBe(405);
    expect(res.headers).toMatchObject({ Allow: 'POST' });
  });
});
