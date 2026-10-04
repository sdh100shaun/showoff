import { BedrockAgentClient, ListIngestionJobsCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { AttributeValue, BatchGetItemCommand, BatchWriteItemCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { logger } from '../shared/logger';

/** A running job is assumed to include changes made at least this long before it started. */
const CLOCK_MARGIN_MS = 5_000;

const bedrock = new BedrockAgentClient({});
const dynamo = new DynamoDBClient({});
const knowledgeBaseId = requiredEnv('KNOWLEDGE_BASE_ID');
const dataSourceId = requiredEnv('DATA_SOURCE_ID');
const trackingTable = requiredEnv('TRACKING_TABLE_NAME');
const ttlSeconds = Number(requiredEnv('TRACKING_TTL_DAYS')) * 86_400;

interface Change {
  record: SQSRecord;
  /** EventBridge event id: the idempotency key for a change. */
  eventId: string;
  time: number;
}

/**
 * Starts one ingestion job for a batch of document-change events.
 *
 * Idempotency: event ids already handed to a job (tracked in DynamoDB with a
 * TTL) are skipped, so duplicate or retried deliveries do not start redundant
 * jobs, and every change can be traced to the job that covered it.
 *
 * Bedrock allows one running job per data source. On conflict, the batch is
 * acknowledged if the running job started after the newest change (so it will
 * pick it up); otherwise the messages return to the queue and are retried after
 * the visibility timeout. Persistent failures land in the DLQ.
 */
export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
  logger.addContext(context);
  const changes = event.Records.map(toChange);
  if (changes.length === 0) return { batchItemFailures: [] };

  const seen = await alreadyProcessed(changes.map((c) => c.eventId));
  const fresh = changes.filter((c) => !seen.has(c.eventId));
  if (fresh.length < changes.length) logger.info('Skipped already-processed changes', { duplicates: changes.length - fresh.length });
  if (fresh.length === 0) return { batchItemFailures: [] };

  const newestChange = Math.max(...fresh.map((c) => c.time));
  try {
    const res = await bedrock.send(
      new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId, description: `Triggered by ${fresh.length} change event(s)` }),
    );
    const jobId = res.ingestionJob?.ingestionJobId ?? 'unknown';
    logger.info('Ingestion job started', { ingestionJobId: jobId, changes: fresh.length });
    await markProcessed(fresh, jobId, 'started');
    return { batchItemFailures: [] };
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name !== 'ConflictException' && name !== 'ThrottlingException') throw e;

    const running = await runningJob();
    if (running && running.startedAt >= newestChange + CLOCK_MARGIN_MS) {
      logger.info('Running ingestion job already covers these changes', { ingestionJobId: running.id, changes: fresh.length });
      await markProcessed(fresh, running.id, 'covered');
      return { batchItemFailures: [] };
    }
    logger.info('Ingestion job busy; will retry', { reason: name, changes: fresh.length });
    return { batchItemFailures: fresh.map((c) => ({ itemIdentifier: c.record.messageId })) };
  }
};

async function runningJob(): Promise<{ id: string; startedAt: number } | undefined> {
  const res = await bedrock.send(
    new ListIngestionJobsCommand({
      knowledgeBaseId,
      dataSourceId,
      filters: [{ attribute: 'STATUS', operator: 'EQ', values: ['STARTING', 'IN_PROGRESS'] }],
      sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
      maxResults: 1,
    }),
  );
  const job = res.ingestionJobSummaries?.[0];
  return job?.startedAt ? { id: job.ingestionJobId ?? 'unknown', startedAt: new Date(job.startedAt).getTime() } : undefined;
}

/** Event ids already recorded. Lookup failures are treated as "not seen" (a redundant job is safe). */
async function alreadyProcessed(eventIds: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const unique = [...new Set(eventIds)];
  try {
    for (const chunk of chunks(unique, 100)) {
      const res = await dynamo.send(
        new BatchGetItemCommand({
          RequestItems: { [trackingTable]: { Keys: chunk.map((id) => ({ pk: { S: eventKey(id) } })), ProjectionExpression: 'pk' } },
        }),
      );
      for (const item of res.Responses?.[trackingTable] ?? []) {
        const pk = item.pk?.S;
        if (pk) seen.add(pk.slice('event#'.length));
      }
    }
  } catch (e) {
    logger.warn('Idempotency lookup failed; continuing', { error: e as Error });
  }
  return seen;
}

/** Best effort: a failed write only means a later duplicate may start a redundant (incremental) job. */
async function markProcessed(changes: Change[], jobId: string, outcome: 'started' | 'covered'): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = { N: String(now + ttlSeconds) };
  const items: Record<string, AttributeValue>[] = changes.map((c) => ({
    pk: { S: eventKey(c.eventId) },
    ingestionJobId: { S: jobId },
    outcome: { S: outcome },
    changeTime: { S: new Date(c.time).toISOString() },
    recordedAt: { N: String(now) },
    expiresAt,
  }));
  if (outcome === 'started') {
    items.push({
      pk: { S: `job#${jobId}` },
      ingestionJobId: { S: jobId },
      outcome: { S: outcome },
      changeTime: { S: new Date(Math.max(...changes.map((c) => c.time))).toISOString() },
      recordedAt: { N: String(now) },
      expiresAt,
      changeCount: { N: String(changes.length) },
    });
  }
  try {
    for (const chunk of chunks(dedupe(items), 25)) {
      await dynamo.send(new BatchWriteItemCommand({ RequestItems: { [trackingTable]: chunk.map((Item) => ({ PutRequest: { Item } })) } }));
    }
  } catch (e) {
    logger.warn('Failed to record processed changes', { error: e as Error, ingestionJobId: jobId });
  }
}

function toChange(record: SQSRecord): Change {
  let eventId = record.messageId;
  let time = Number(record.attributes.SentTimestamp);
  try {
    const body = JSON.parse(record.body) as { id?: unknown; time?: unknown };
    if (typeof body.id === 'string' && /^[\w-]{1,128}$/.test(body.id)) eventId = body.id;
    if (typeof body.time === 'string' && !Number.isNaN(Date.parse(body.time))) time = Date.parse(body.time);
  } catch {
    // Malformed body: fall back to SQS identifiers.
  }
  return { record, eventId, time };
}

/** Event time from the EventBridge envelope, falling back to when SQS received it. */
export function changeTime(record: SQSRecord): number {
  return toChange(record).time;
}

function eventKey(id: string): string {
  return `event#${id}`;
}

function dedupe(items: Record<string, AttributeValue>[]): Record<string, AttributeValue>[] {
  return [...new Map(items.map((i) => [i.pk?.S, i])).values()];
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}
