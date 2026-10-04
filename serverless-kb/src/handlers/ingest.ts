import { BedrockAgentClient, ListIngestionJobsCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { logger } from '../shared/logger';

/** A running job is assumed to include changes made at least this long before it started. */
const CLOCK_MARGIN_MS = 5_000;

const client = new BedrockAgentClient({});
const knowledgeBaseId = requiredEnv('KNOWLEDGE_BASE_ID');
const dataSourceId = requiredEnv('DATA_SOURCE_ID');

/**
 * Starts one ingestion job for a batch of document-change events.
 *
 * Bedrock allows one running job per data source. On conflict, the batch is
 * acknowledged if the running job started after the newest change (so it will
 * pick it up); otherwise every message is returned to the queue and retried
 * after the visibility timeout. Persistent failures land in the DLQ.
 */
export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
  logger.addContext(context);
  if (event.Records.length === 0) return { batchItemFailures: [] };

  const newestChange = Math.max(...event.Records.map(changeTime));
  const retryAll = (): SQSBatchResponse => ({ batchItemFailures: event.Records.map((r) => ({ itemIdentifier: r.messageId })) });

  try {
    const res = await client.send(
      new StartIngestionJobCommand({
        knowledgeBaseId,
        dataSourceId,
        description: `Triggered by ${event.Records.length} change event(s)`,
      }),
    );
    logger.info('Ingestion job started', { ingestionJobId: res.ingestionJob?.ingestionJobId, changes: event.Records.length });
    return { batchItemFailures: [] };
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name !== 'ConflictException' && name !== 'ThrottlingException') throw e;

    const runningStartedAt = await runningJobStartTime();
    if (runningStartedAt !== undefined && runningStartedAt >= newestChange + CLOCK_MARGIN_MS) {
      logger.info('Running ingestion job already covers these changes', { changes: event.Records.length });
      return { batchItemFailures: [] };
    }
    logger.info('Ingestion job busy; will retry', { reason: name, changes: event.Records.length });
    return retryAll();
  }
};

async function runningJobStartTime(): Promise<number | undefined> {
  const res = await client.send(
    new ListIngestionJobsCommand({
      knowledgeBaseId,
      dataSourceId,
      filters: [{ attribute: 'STATUS', operator: 'EQ', values: ['STARTING', 'IN_PROGRESS'] }],
      sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
      maxResults: 1,
    }),
  );
  const startedAt = res.ingestionJobSummaries?.[0]?.startedAt;
  return startedAt ? new Date(startedAt).getTime() : undefined;
}

/** Event time from the EventBridge envelope, falling back to when SQS received it. */
export function changeTime(record: SQSRecord): number {
  try {
    const body = JSON.parse(record.body) as { time?: unknown };
    if (typeof body.time === 'string') {
      const t = Date.parse(body.time);
      if (!Number.isNaN(t)) return t;
    }
  } catch {
    // fall through
  }
  return Number(record.attributes.SentTimestamp);
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}
