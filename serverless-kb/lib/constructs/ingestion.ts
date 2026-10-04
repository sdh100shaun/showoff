import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambdaEvents from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { KbConfig } from '../config';
import { SecureFunction } from './secure-function';

export interface IngestionProps {
  readonly key: kms.IKey;
  readonly documentBucket: s3.IBucket;
  readonly documentPrefix: string;
  readonly knowledgeBaseId: string;
  readonly knowledgeBaseArn: string;
  readonly dataSourceId: string;
  readonly settings: KbConfig['ingestion'];
  readonly logRetention: logs.RetentionDays;
  readonly removalPolicy: RemovalPolicy;
  readonly vpc?: ec2.IVpc;
  readonly securityGroup?: ec2.ISecurityGroup;
}

/**
 * Keeps the knowledge base in sync with the document bucket.
 *
 * S3 change events (and an optional schedule) are buffered in SQS so a burst
 * of uploads becomes one ingestion job. Bedrock runs one job per data source
 * at a time; if a job is already running, the handler either recognises that
 * it covers the change or returns the messages to the queue to retry later.
 */
export class Ingestion extends Construct {
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly function: SecureFunction;

  constructor(scope: Construct, id: string, props: IngestionProps) {
    super(scope, id);
    const { settings } = props;

    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.key,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: props.removalPolicy,
    });

    this.queue = new sqs.Queue(this, 'Queue', {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.key,
      enforceSSL: true,
      // Doubles as the retry delay when a job is already running.
      visibilityTimeout: Duration.seconds(settings.retryDelaySeconds),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: settings.maxReceiveCount },
      removalPolicy: props.removalPolicy,
    });

    if (settings.eventDriven) {
      new events.Rule(this, 'DocumentChangedRule', {
        description: 'Document created or deleted under the indexed prefix',
        eventPattern: {
          source: ['aws.s3'],
          detailType: ['Object Created', 'Object Deleted'],
          detail: {
            bucket: { name: [props.documentBucket.bucketName] },
            object: { key: [{ prefix: props.documentPrefix }] },
          },
        },
        targets: [new targets.SqsQueue(this.queue)],
      });
    }

    if (settings.scheduleExpression) {
      new events.Rule(this, 'ScheduledSyncRule', {
        description: 'Periodic full sync of the knowledge base',
        schedule: events.Schedule.expression(settings.scheduleExpression),
        targets: [new targets.SqsQueue(this.queue)],
      });
    }

    this.function = new SecureFunction(this, 'Trigger', {
      handler: 'ingest',
      description: 'Starts Bedrock knowledge base ingestion jobs from queued change events',
      key: props.key,
      logRetention: props.logRetention,
      removalPolicy: props.removalPolicy,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        DATA_SOURCE_ID: props.dataSourceId,
        POWERTOOLS_SERVICE_NAME: 'kb-ingest',
      },
      vpc: props.vpc,
      securityGroup: props.securityGroup,
    });

    this.function.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:StartIngestionJob', 'bedrock:ListIngestionJobs'],
        resources: [props.knowledgeBaseArn],
      }),
    );

    this.function.fn.addEventSource(
      new lambdaEvents.SqsEventSource(this.queue, {
        // SQS only allows batches larger than 10 when a batching window is set.
        batchSize: settings.batchWindowSeconds > 0 ? 100 : 10,
        maxBatchingWindow: Duration.seconds(settings.batchWindowSeconds),
        reportBatchItemFailures: true,
        // Ingestion jobs are serialised by Bedrock anyway; keep pollers minimal.
        maxConcurrency: 2,
      }),
    );
  }
}
