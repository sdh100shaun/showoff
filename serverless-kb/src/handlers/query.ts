import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { AccessError, can, Capability, resolveCaller } from '../core/access';
import { AuditSink } from '../core/audit';
import { handleMcp } from '../core/mcp';
import { Retrieval } from '../core/retrieval';
import { ContextService, publicError } from '../core/service';
import { settingsFromEnv } from '../core/settings';
import { empty, error, json } from '../shared/http';
import { logger } from '../shared/logger';
import { describeIssues, QueryRequest, requestSchema } from '../shared/validation';

const MAX_BODY_BYTES = 16 * 1024;

const settings = settingsFromEnv(process.env);
const schema = requestSchema(settings);
const service = new ContextService(
  new Retrieval(new BedrockAgentRuntimeClient({}), settings),
  new AuditSink(new EventBridgeClient({}), settings.audit.busName),
  settings,
);

type Route = 'retrieve' | 'ask' | 'mcp';

export const handler = async (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);
  const requestId = event.requestContext?.requestId ?? context.awsRequestId;
  const route = routeOf(event);
  if (!route) return error(404, 'Not found', requestId);
  if (event.httpMethod !== 'POST') {
    // MCP Streamable HTTP: no SSE stream is offered, so GET/DELETE are 405.
    const res = error(405, 'Method not allowed', requestId);
    return { ...res, headers: { ...res.headers, Allow: 'POST' } };
  }
  if (route === 'mcp' && event.headers?.origin !== undefined) {
    // Server-to-server only; refuse browser-originated MCP requests (DNS-rebinding/CSRF defence).
    return error(403, 'Forbidden', requestId);
  }

  const raw = decodeBody(event);
  if (raw !== null && Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return error(413, 'Payload too large', requestId);

  try {
    const caller = resolveCaller(event.requestContext?.authorizer?.claims as Record<string, unknown> | undefined, event.headers, settings);

    if (route === 'mcp') {
      const res = await handleMcp(raw, caller, settings, service, requestId);
      return res.body === undefined ? empty(res.statusCode, requestId) : json(res.statusCode, res.body, requestId);
    }

    // Defence in depth: API Gateway already enforced the scope.
    if (!can(caller, route as Capability, settings)) {
      logger.warn('Missing required scope', { route, clientId: caller.clientId });
      return error(403, 'Forbidden', requestId);
    }
    if (route === 'ask' && !settings.generation) return error(404, 'Not found', requestId);

    const parsed = parseBody(raw);
    if ('error' in parsed) return error(400, 'Invalid request', requestId, parsed.error);

    const body =
      route === 'retrieve'
        ? await service.serve('retrieve', parsed.value, caller, { requestId, channel: 'rest' })
        : await service.serve('ask', parsed.value, caller, { requestId, channel: 'rest' });
    return json(200, body, requestId);
  } catch (e) {
    if (e instanceof AccessError) {
      logger.warn('Access denied', { route, reason: e.message });
      return error(e.statusCode, e.statusCode === 403 ? 'Forbidden' : e.message, requestId);
    }
    const err = publicError(e);
    logger[err.severity]('Request failed', { route, errorName: (e as Error)?.name, ...(err.severity === 'error' ? { error: e as Error } : {}) });
    return error(err.statusCode, err.message, requestId);
  }
};

function decodeBody(event: APIGatewayProxyEvent): string | null {
  if (!event.body) return null;
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

function parseBody(raw: string | null): { value: QueryRequest } | { error: string[] } {
  if (!raw) return { error: ['body is required'] };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: ['body must be valid JSON'] };
  }
  const result = schema.safeParse(data);
  // Report paths and messages only, never echo input values.
  return result.success ? { value: result.data } : { error: describeIssues(result.error) };
}

function routeOf(event: APIGatewayProxyEvent): Route | undefined {
  switch (event.resource) {
    case '/retrieve':
      return 'retrieve';
    case '/ask':
      return 'ask';
    case '/mcp':
      return 'mcp';
    default:
      return undefined;
  }
}
