import './env/ingest-env';
import { BedrockAgentClient, ListIngestionJobsCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { BatchGetItemCommand, BatchWriteItemCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { changeTime, handler } from '../src/handlers/ingest';

const bedrock = mockClient(BedrockAgentClient);
const dynamo = mockClient(DynamoDBClient);
const context = { awsRequestId: 'req-1' } as unknown as Context;

function record(id: string, time: string, eventId = `evt-${id}`): SQSRecord {
  return {
    messageId: id,
    body: JSON.stringify({ id: eventId, source: 'aws.s3', 'detail-type': 'Object Created', time }),
    attributes: { SentTimestamp: String(Date.parse(time)) },
  } as unknown as SQSRecord;
}
const batch = (...records: SQSRecord[]) => ({ Records: records }) as SQSEvent;
const conflict = Object.assign(new Error('job running'), { name: 'ConflictException' });

function writtenKeys(): string[] {
  return dynamo
    .commandCalls(BatchWriteItemCommand)
    .flatMap((c) => c.args[0].input.RequestItems!.tracking!.map((r) => r.PutRequest!.Item!.pk!.S!));
}

beforeEach(() => {
  bedrock.reset();
  dynamo.reset();
  dynamo.on(BatchGetItemCommand).resolves({ Responses: { tracking: [] } });
  dynamo.on(BatchWriteItemCommand).resolves({});
});

test('starts one ingestion job for the batch and records idempotency keys', async () => {
  bedrock.on(StartIngestionJobCommand).resolves({ ingestionJob: { ingestionJobId: 'job-1' } as never });
  const res = await handler(batch(record('a', '2026-01-01T10:00:00Z'), record('b', '2026-01-01T10:00:01Z')), context);
  expect(res.batchItemFailures).toEqual([]);
  expect(bedrock).toHaveReceivedCommandTimes(StartIngestionJobCommand, 1);
  expect(bedrock).toHaveReceivedCommandWith(StartIngestionJobCommand, { knowledgeBaseId: 'KBTEST1234', dataSourceId: 'DSTEST1234' });
  expect(writtenKeys().sort()).toEqual(['event#evt-a', 'event#evt-b', 'job#job-1']);
  const item = dynamo.commandCalls(BatchWriteItemCommand)[0]!.args[0].input.RequestItems!.tracking![0]!.PutRequest!.Item!;
  expect(item.ingestionJobId).toEqual({ S: 'job-1' });
  expect(Number(item.expiresAt!.N)).toBeGreaterThan(Date.now() / 1000 + 29 * 86400);
});

test('skips duplicate deliveries without starting a job', async () => {
  dynamo.on(BatchGetItemCommand).resolves({ Responses: { tracking: [{ pk: { S: 'event#evt-a' } }] } });
  const res = await handler(batch(record('a', '2026-01-01T10:00:00Z')), context);
  expect(res.batchItemFailures).toEqual([]);
  expect(bedrock).not.toHaveReceivedCommand(StartIngestionJobCommand);
});

test('only new changes count toward a job; duplicates are acknowledged', async () => {
  dynamo.on(BatchGetItemCommand).resolves({ Responses: { tracking: [{ pk: { S: 'event#evt-a' } }] } });
  bedrock.on(StartIngestionJobCommand).rejects(conflict);
  bedrock.on(ListIngestionJobsCommand).resolves({ ingestionJobSummaries: [] });
  const res = await handler(batch(record('a', '2026-01-01T10:00:00Z'), record('b', '2026-01-01T10:00:01Z')), context);
  expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'b' }]);
});

test('acknowledges and records "covered" when a running job started after the newest change', async () => {
  bedrock.on(StartIngestionJobCommand).rejects(conflict);
  bedrock.on(ListIngestionJobsCommand).resolves({ ingestionJobSummaries: [{ ingestionJobId: 'job-9', startedAt: new Date('2026-01-01T10:05:00Z') } as never] });
  const res = await handler(batch(record('a', '2026-01-01T10:00:00Z')), context);
  expect(res.batchItemFailures).toEqual([]);
  expect(writtenKeys()).toEqual(['event#evt-a']);
});

test('retries when the running job may predate the change', async () => {
  bedrock.on(StartIngestionJobCommand).rejects(conflict);
  bedrock.on(ListIngestionJobsCommand).resolves({ ingestionJobSummaries: [{ ingestionJobId: 'job-9', startedAt: new Date('2026-01-01T10:00:02Z') } as never] });
  const res = await handler(batch(record('a', '2026-01-01T10:00:00Z'), record('b', '2026-01-01T09:00:00Z')), context);
  expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'a' }, { itemIdentifier: 'b' }]);
  expect(dynamo).not.toHaveReceivedCommand(BatchWriteItemCommand);
});

test('retries on throttling when no job is running', async () => {
  bedrock.on(StartIngestionJobCommand).rejects(Object.assign(new Error('slow'), { name: 'ThrottlingException' }));
  bedrock.on(ListIngestionJobsCommand).resolves({ ingestionJobSummaries: [] });
  const res = await handler(batch(record('a', '2026-01-01T10:00:00Z')), context);
  expect(res.batchItemFailures).toHaveLength(1);
});

test('tracking-table failures never block ingestion', async () => {
  dynamo.on(BatchGetItemCommand).rejects(new Error('ddb down'));
  dynamo.on(BatchWriteItemCommand).rejects(new Error('ddb down'));
  bedrock.on(StartIngestionJobCommand).resolves({ ingestionJob: { ingestionJobId: 'job-1' } as never });
  const res = await handler(batch(record('a', '2026-01-01T10:00:00Z')), context);
  expect(res.batchItemFailures).toEqual([]);
  expect(bedrock).toHaveReceivedCommandTimes(StartIngestionJobCommand, 1);
});

test('unexpected errors fail the invocation', async () => {
  bedrock.on(StartIngestionJobCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
  await expect(handler(batch(record('a', '2026-01-01T10:00:00Z')), context)).rejects.toThrow('denied');
});

test('changeTime falls back to the SQS timestamp for malformed bodies', () => {
  const r = { messageId: 'x', body: 'not json', attributes: { SentTimestamp: '1700000000000' } } as unknown as SQSRecord;
  expect(changeTime(r)).toBe(1700000000000);
});
