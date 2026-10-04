import { logger } from '../shared/logger';
import type { QueryRequest } from '../shared/validation';
import type { Caller } from './access';
import { AuditSink, contextServed, ContextServedEvent } from './audit';
import type { AskResult, Retrieval, RetrieveResult } from './retrieval';
import type { Settings } from './settings';

export class AuditUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Audit trail unavailable', { cause });
    this.name = 'AuditUnavailableError';
  }
}

/** Serves context and records what was served, the same for REST and MCP callers. */
export class ContextService {
  constructor(
    private readonly retrieval: Retrieval,
    private readonly audit: AuditSink,
    private readonly settings: Settings,
  ) {}

  serve(operation: 'retrieve', req: QueryRequest, caller: Caller, meta: Meta): Promise<RetrieveResult>;
  serve(operation: 'ask', req: QueryRequest, caller: Caller, meta: Meta): Promise<AskResult>;
  async serve(operation: 'retrieve' | 'ask', req: QueryRequest, caller: Caller, meta: Meta): Promise<RetrieveResult | AskResult> {
    const started = Date.now();
    const result = operation === 'retrieve' ? await this.retrieval.retrieve(req, caller) : await this.retrieval.ask(req, caller);

    const event = contextServed({
      requestId: meta.requestId,
      channel: meta.channel,
      operation,
      caller,
      query: req.query,
      filterKeys: Object.keys(req.filter ?? {}),
      references: result.references,
      answerReturned: 'answer' in result,
    });
    await this.recordAudit(event);

    logger.info('Context served', {
      operation,
      channel: meta.channel,
      clientId: caller.clientId,
      onBehalfOf: caller.onBehalfOf,
      runId: caller.runId,
      accessGroups: caller.accessGroups,
      queryLength: req.query.length,
      resultCount: result.references.length,
      estimatedTokens: result.usage.estimatedTokens,
      truncated: result.usage.truncated,
      durationMs: Date.now() - started,
      ...(this.settings.logQueries ? { query: req.query } : {}),
    });
    return result;
  }

  private async recordAudit(event: ContextServedEvent): Promise<void> {
    if (!this.audit.enabled) return;
    try {
      await this.audit.record(event);
    } catch (e) {
      logger.error('Failed to record audit event', { error: e as Error, requestId: event.requestId });
      // Fail closed: context that cannot be audited is not returned.
      if (this.settings.audit.failClosed) throw new AuditUnavailableError(e);
    }
  }
}

export interface Meta {
  requestId: string;
  channel: 'rest' | 'mcp';
}

/** Maps internal failures to safe, generic public errors. */
export function publicError(e: unknown): { statusCode: number; message: string; severity: 'warn' | 'error' } {
  const name = (e as { name?: string })?.name ?? 'Error';
  switch (name) {
    case 'ValidationException':
      return { statusCode: 400, message: 'Invalid request', severity: 'warn' };
    case 'ThrottlingException':
    case 'ServiceQuotaExceededException':
      return { statusCode: 429, message: 'Too many requests', severity: 'warn' };
    case 'AuditUnavailableError':
      return { statusCode: 503, message: 'Service unavailable', severity: 'error' };
    default:
      // AccessDenied/ResourceNotFound indicate misconfiguration: log, do not reveal.
      return { statusCode: 500, message: 'Internal error', severity: 'error' };
  }
}
