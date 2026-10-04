import './env/ingest-env';
import { BedrockAgentClient, ListIngestionJobsCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { changeTime, handler } from '../src/handlers/ingest';

const bedrock = mockClient(BedrockAgentClient);
const context = { awsRequestId: 'req-1' } as unknown as Context;

function record(id: string, time: string): SQSRecord {
  return {
    messageId: id,
    body: JSON.stringify({ source: 'aws.s3', 'detail-type': 'Object Created', time }),
    attributes: { SentTimestamp: String(Date.parse(time)) },
  } as unknown as SQSRecord;
}
const conflict = Object.assign(new Error('job running'), { name: 'ConflictException' });

beforeEach(() => bedrock.reset());

test('starts one ingestion job for the whole batch', async () => {
  bedrock.on(StartIngestionJobCommand).resolves({ ingestionJob: { ingestionJobId: 'job-1' } as never });
  const res = await handler({ Records: [record('a', '2026-01-01T10:00:00Z'), record('b', '2026-01-01T10:00:01Z')] } as SQSEvent, context);
  expect(res.batchItemFailures).toEqual([]);
  expect(bedrock).toHaveReceivedCommandTimes(StartIngestionJobCommand, 1);
  expect(bedrock).toHaveReceivedCommandWith(StartIngestionJobCommand, { knowledgeBaseId: 'KBTEST1234', dataSourceId: 'DSTEST1234' });
});

test('acknowledges when a running job started after the newest change', async () => {
  bedrock.on(StartIngestionJobCommand).rejects(conflict);
  bedrock.on(ListIngestionJobsCommand).resolves({ ingestionJobSummaries: [{ startedAt: new Date('2026-01-01T10:05:00Z') } as never] });
  const res = await handler({ Records: [record('a', '2026-01-01T10:00:00Z')] } as SQSEvent, context);
  expect(res.batchItemFailures).toEqual([]);
});

test('retries all messages when the running job may predate the change', async () => {
  bedrock.on(StartIngestionJobCommand).rejects(conflict);
  bedrock.on(ListIngestionJobsCommand).resolves({ ingestionJobSummaries: [{ startedAt: new Date('2026-01-01T10:00:02Z') } as never] });
  const res = await handler({ Records: [record('a', '2026-01-01T10:00:00Z'), record('b', '2026-01-01T09:00:00Z')] } as SQSEvent, context);
  expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'a' }, { itemIdentifier: 'b' }]);
});

test('retries on throttling when no job is running', async () => {
  bedrock.on(StartIngestionJobCommand).rejects(Object.assign(new Error('slow'), { name: 'ThrottlingException' }));
  bedrock.on(ListIngestionJobsCommand).resolves({ ingestionJobSummaries: [] });
  const res = await handler({ Records: [record('a', '2026-01-01T10:00:00Z')] } as SQSEvent, context);
  expect(res.batchItemFailures).toHaveLength(1);
});

test('unexpected errors fail the invocation', async () => {
  bedrock.on(StartIngestionJobCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
  await expect(handler({ Records: [record('a', '2026-01-01T10:00:00Z')] } as SQSEvent, context)).rejects.toThrow('denied');
});

test('changeTime falls back to the SQS timestamp for malformed bodies', () => {
  const r = { messageId: 'x', body: 'not json', attributes: { SentTimestamp: '1700000000000' } } as unknown as SQSRecord;
  expect(changeTime(r)).toBe(1700000000000);
});
