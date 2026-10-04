import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface EncryptionProps {
  readonly removalPolicy: RemovalPolicy;
}

/**
 * Customer-managed KMS key for data at rest across the stack.
 *
 * The default CDK key policy delegates to IAM in this account. Service
 * principals that act on our behalf are granted explicitly here, each scoped
 * to this account (confused-deputy protection).
 */
export class Encryption extends Construct {
  public readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: EncryptionProps) {
    super(scope, id);
    const { account, region, partition } = Stack.of(this);

    this.key = new kms.Key(this, 'Key', {
      description: 'Encrypts knowledge base documents, vectors, queues and logs',
      enableKeyRotation: true,
      rotationPeriod: Duration.days(365),
      pendingWindow: Duration.days(props.removalPolicy === RemovalPolicy.DESTROY ? 7 : 30),
      removalPolicy: props.removalPolicy,
    });

    // CloudWatch Logs: encrypt log groups in this account only.
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new iam.ServicePrincipal(`logs.${region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${partition}:logs:${region}:${account}:log-group:*` },
        },
      }),
    );

    // EventBridge delivering S3 events into the encrypted SQS queue, and
    // CloudWatch alarms publishing to the encrypted SNS topic.
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEventBridgeAndCloudWatchToEncryptedTargets',
        principals: [new iam.ServicePrincipal('events.amazonaws.com'), new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': account } },
      }),
    );

    // S3 Vectors background index maintenance needs to decrypt with the CMK.
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowS3VectorsIndexing',
        principals: [new iam.ServicePrincipal('indexing.s3vectors.amazonaws.com')],
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${partition}:s3vectors:${region}:${account}:bucket/*` },
        },
      }),
    );
  }
}
