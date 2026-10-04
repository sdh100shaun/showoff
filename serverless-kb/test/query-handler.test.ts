import './env/query-env';
import { BedrockAgentRuntimeClient, RetrieveAndGenerateCommand, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { handler, objectKey, PROMPT_TEMPLATE, toReference } from '../src/handlers/query';

const bedrock = mockClient(BedrockAgentRuntimeClient);
const context = { awsRequestId: 'req-1', functionName: 'query' } as unknown as Context;

function event(resource: string, body: unknown, scope = 'kb-api/retrieve kb-api/ask'): APIGatewayProxyEvent {
  return {
    resource,
    httpMethod: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { requestId: 'api-req-1', authorizer: { claims: { scope, client_id: 'client-abc' } } },
  } as unknown as APIGatewayProxyEvent;
}

const sampleResult = {
  content: { text: 'Chunk text', type: 'TEXT' as const },
  score: 0.87,
  location: { type: 'S3' as const, s3Location: { uri: 's3://secret-bucket-name/documents/policy.pdf' } },
  metadata: {
    'x-amz-bedrock-kb-source-uri': 's3://secret-bucket-name/documents/policy.pdf',
    'x-amz-bedrock-kb-chunk-id': 'chunk-1',
    'x-amz-bedrock-kb-data-source-id': 'DS1',
    department: 'finance',
  },
};

beforeEach(() => bedrock.reset());

describe('POST /retrieve', () => {
  test('returns references without leaking the bucket name or system metadata', async () => {
    bedrock.on(RetrieveCommand).resolves({ retrievalResults: [sampleResult] });
    const res = await handler(event('/retrieve', { query: 'travel policy' }), context);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('secret-bucket-name');
    expect(res.body).not.toContain('x-amz-bedrock-kb');
    expect(JSON.parse(res.body)).toEqual({
      references: [{ text: 'Chunk text', score: 0.87, source: { key: 'documents/policy.pdf' }, chunkId: 'chunk-1', metadata: { department: 'finance' } }],
    });
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  });

  test('passes knowledge base id, result count and filters to Bedrock', async () => {
    bedrock.on(RetrieveCommand).resolves({ retrievalResults: [] });
    await handler(event('/retrieve', { query: 'q', maxResults: 3, filter: { department: 'hr', doc_type: ['policy', 'faq'] } }), context);
    expect(bedrock).toHaveReceivedCommandWith(RetrieveCommand, {
      knowledgeBaseId: 'KBTEST1234',
      retrievalQuery: { text: 'q' },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: 3,
          filter: { andAll: [{ equals: { key: 'department', value: 'hr' } }, { in: { key: 'doc_type', value: ['policy', 'faq'] } }] },
        },
      },
    });
  });

  test.each([
    ['missing body', undefined],
    ['invalid JSON', '{nope'],
    ['empty query', { query: '   ' }],
    ['query too long', { query: 'x'.repeat(101) }],
    ['maxResults above cap', { query: 'q', maxResults: 11 }],
    ['unknown field', { query: 'q', sessionId: 'abc' }],
    ['filter key not allowed', { query: 'q', filter: { owner: 'me' } }],
    ['empty filter', { query: 'q', filter: {} }],
    ['oversized body', { query: 'q', pad: 'x'.repeat(20_000) }],
  ])('rejects %s with 400 and calls nothing', async (_name, body) => {
    const e = event('/retrieve', body ?? '');
    if (body === undefined) e.body = null;
    const res = await handler(e, context);
    expect(res.statusCode).toBe(400);
    expect(bedrock).not.toHaveReceivedAnyCommand();
  });

  test('error messages do not echo input values', async () => {
    const res = await handler(event('/retrieve', { query: 'q', filter: { '<script>': 'x' } }), context);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('<script>');
  });

  test('rejects callers without the retrieve scope (defence in depth)', async () => {
    const res = await handler(event('/retrieve', { query: 'q' }, 'kb-api/ask'), context);
    expect(res.statusCode).toBe(403);
    expect(bedrock).not.toHaveReceivedAnyCommand();
  });

  test('does not accept a scope from another resource server', async () => {
    const res = await handler(event('/retrieve', { query: 'q' }, 'other-api/retrieve'), context);
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
  test('uses the hardened prompt template and returns answer with citations', async () => {
    bedrock.on(RetrieveAndGenerateCommand).resolves({
      output: { text: 'The answer.' },
      citations: [{ retrievedReferences: [sampleResult] }],
    });
    const res = await handler(event('/ask', { query: 'what is the policy?' }, 'kb-api/ask'), context);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.answer).toBe('The answer.');
    expect(body.references[0].source).toEqual({ key: 'documents/policy.pdf' });
    expect(bedrock).toHaveReceivedCommandWith(RetrieveAndGenerateCommand, {
      retrieveAndGenerateConfiguration: expect.objectContaining({
        knowledgeBaseConfiguration: expect.objectContaining({
          generationConfiguration: { promptTemplate: { textPromptTemplate: PROMPT_TEMPLATE } },
        }),
      }),
    });
    const input = bedrock.commandCalls(RetrieveAndGenerateCommand)[0]!.args[0].input;
    expect(input.sessionId).toBeUndefined();
    expect(PROMPT_TEMPLATE).toContain('$search_results$');
  });
});

describe('helpers', () => {
  test('objectKey strips scheme and bucket', () => {
    expect(objectKey({ type: 'S3', s3Location: { uri: 's3://b/a/b/c.txt' } })).toBe('a/b/c.txt');
    expect(objectKey({ type: 'WEB' })).toBeUndefined();
  });
  test('toReference tolerates missing fields', () => {
    expect(toReference({})).toEqual({ text: '', metadata: {} });
  });
});
