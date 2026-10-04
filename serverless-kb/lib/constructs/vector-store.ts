import { RemovalPolicy } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { Construct } from 'constructs';

export interface VectorStoreProps {
  readonly key: kms.IKey;
  readonly dimension: number;
  readonly distanceMetric: 'cosine' | 'euclidean';
  readonly removalPolicy: RemovalPolicy;
}

/**
 * Amazon S3 Vectors bucket and index used as the knowledge base vector store.
 *
 * Names are left to CloudFormation so they are unique and do not reveal
 * anything about the deployment.
 */
export class VectorStore extends Construct {
  public readonly vectorBucket: s3vectors.CfnVectorBucket;
  public readonly index: s3vectors.CfnIndex;

  constructor(scope: Construct, id: string, props: VectorStoreProps) {
    super(scope, id);

    const encryptionConfiguration = { sseType: 'aws:kms', kmsKeyArn: props.key.keyArn };

    this.vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', { encryptionConfiguration });
    this.vectorBucket.applyRemovalPolicy(props.removalPolicy);

    this.index = new s3vectors.CfnIndex(this, 'Index', {
      vectorBucketArn: this.vectorBucket.attrVectorBucketArn,
      dataType: 'float32',
      dimension: props.dimension,
      distanceMetric: props.distanceMetric,
      encryptionConfiguration,
      metadataConfiguration: {
        // Bedrock stores chunk text and its own metadata on each vector. These
        // exceed the 2 KB filterable-metadata limit, so they must be
        // non-filterable (they still count toward the 40 KB total).
        nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
      },
    });
    this.index.applyRemovalPolicy(props.removalPolicy);
  }
}
