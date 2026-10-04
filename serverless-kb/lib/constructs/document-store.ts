import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface DocumentStoreProps {
  readonly key: kms.IKey;
  readonly removalPolicy: RemovalPolicy;
  readonly noncurrentVersionExpirationDays: number;
  readonly accessLogExpirationDays: number;
  /** When non-empty, only these principals may write or delete documents. */
  readonly writerPrincipalArns: string[];
}

/** S3 bucket holding the source documents that the knowledge base indexes. */
export class DocumentStore extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly accessLogBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DocumentStoreProps) {
    super(scope, id);

    // Server access logging only supports SSE-S3 on the destination bucket.
    this.accessLogBucket = new s3.Bucket(this, 'AccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: false,
      lifecycleRules: [{ expiration: Duration.days(props.accessLogExpirationDays) }],
      removalPolicy: props.removalPolicy,
    });

    this.bucket = new s3.Bucket(this, 'Documents', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      eventBridgeEnabled: true,
      serverAccessLogsBucket: this.accessLogBucket,
      serverAccessLogsPrefix: 'documents/',
      lifecycleRules: [
        { noncurrentVersionExpiration: Duration.days(props.noncurrentVersionExpirationDays) },
        { abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
      removalPolicy: props.removalPolicy,
    });

    // Reject uploads that explicitly ask for a different KMS key or for SSE-S3,
    // so every document is encrypted with the stack CMK. Clients should simply
    // omit encryption headers.
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyWrongKmsKey',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.bucket.arnForObjects('*')],
        conditions: {
          // Only applies when the header is present; omitted headers fall back to the bucket default (the CMK).
          Null: { 's3:x-amz-server-side-encryption-aws-kms-key-id': 'false' },
          StringNotEquals: { 's3:x-amz-server-side-encryption-aws-kms-key-id': props.key.keyArn },
        },
      }),
    );
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyNonKmsEncryption',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.bucket.arnForObjects('*')],
        conditions: {
          Null: { 's3:x-amz-server-side-encryption': 'false' },
          StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
        },
      }),
    );

    // Documents become model context, so write access is a prompt-injection
    // path. Optionally restrict writers to an explicit allow-list.
    if (props.writerPrincipalArns.length > 0) {
      this.bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'DenyWritesExceptAllowedWriters',
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:RestoreObject', 's3:PutObjectTagging'],
          resources: [this.bucket.arnForObjects('*')],
          conditions: { ArnNotLike: { 'aws:PrincipalArn': props.writerPrincipalArns } },
        }),
      );
    }
  }
}
