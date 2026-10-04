import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { createHash } from 'crypto';
import type { Caller } from './access';
import type { Reference } from './retrieval';

export const AUDIT_SOURCE = 'kb.retrieval';
export const AUDIT_DETAIL_TYPE = 'ContextServed';

/**
 * "What context was each agent given": one event per response. It contains
 * identifiers and source references only, never query or document text, so
 * the audit store does not become a second copy of the corpus. The query is
 * recorded as a SHA-256 hash for correlation.
 */
export interface ContextServedEvent {
  requestId: string;
  channel: 'rest' | 'mcp';
  operation: 'retrieve' | 'ask';
  clientId?: string;
  delegated: boolean;
  onBehalfOf?: string;
  agentId?: string;
  runId?: string;
  traceId?: string;
  accessGroups: string[];
  filterKeys: string[];
  queryHash: string;
  queryLength: number;
  answerReturned: boolean;
  references: { sourceKey?: string; chunkId?: string; score?: number }[];
  servedAt: string;
}

export function contextServed(args: {
  requestId: string;
  channel: ContextServedEvent['channel'];
  operation: ContextServedEvent['operation'];
  caller: Caller;
  query: string;
  filterKeys: string[];
  references: Reference[];
  answerReturned: boolean;
  now?: Date;
}): ContextServedEvent {
  const { caller } = args;
  return {
    requestId: args.requestId,
    channel: args.channel,
    operation: args.operation,
    clientId: caller.clientId,
    delegated: caller.delegated ?? false,
    onBehalfOf: caller.onBehalfOf,
    agentId: caller.agentId,
    runId: caller.runId,
    traceId: caller.traceId,
    accessGroups: caller.accessGroups,
    filterKeys: args.filterKeys,
    queryHash: createHash('sha256').update(args.query).digest('hex'),
    queryLength: args.query.length,
    answerReturned: args.answerReturned,
    references: args.references.map((r) => ({ sourceKey: r.source?.key, chunkId: r.chunkId, score: r.score })),
    servedAt: (args.now ?? new Date()).toISOString(),
  };
}

export class AuditSink {
  constructor(
    private readonly client: EventBridgeClient,
    private readonly busName: string | undefined,
  ) {}

  get enabled(): boolean {
    return !!this.busName;
  }

  /** Throws if the event was not accepted, so callers can fail closed. */
  async record(event: ContextServedEvent): Promise<void> {
    if (!this.busName) return;
    const res = await this.client.send(
      new PutEventsCommand({
        Entries: [{ EventBusName: this.busName, Source: AUDIT_SOURCE, DetailType: AUDIT_DETAIL_TYPE, Detail: JSON.stringify(event) }],
      }),
    );
    if ((res.FailedEntryCount ?? 0) > 0) {
      throw new Error(`Audit event rejected: ${res.Entries?.[0]?.ErrorCode ?? 'unknown'}`);
    }
  }
}
