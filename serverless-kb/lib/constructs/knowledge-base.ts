import { Stack } from 'aws-cdk-lib';
import { createHash } from 'crypto';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { KbConfig } from '../config';
import { VectorStore } from './vector-store';

export interface KnowledgeBaseProps {
  readonly key: kms.IKey;
  readonly documentBucket: s3.IBucket;
  readonly documentPrefix: string;
  readonly vectorStore: VectorStore;
  readonly settings: KbConfig['knowledgeBase'];
  readonly description: string;
}

/** Bedrock Knowledge Base backed by S3 Vectors, with an S3 data source. */
export class KnowledgeBase extends Construct {
  public readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  public readonly dataSource: bedrock.CfnDataSource;
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: KnowledgeBaseProps) {
    super(scope, id);
    const { account, region, partition } = Stack.of(this);
    const { settings } = props;

    const embeddingModelArn = `arn:${partition}:bedrock:${region}::foundation-model/${settings.embeddingModelId}`;

    // Service role assumed by Bedrock. The trust policy is pinned to
    // knowledge bases in this account and region (confused-deputy protection).
    this.role = new iam.Role(this, 'ServiceRole', {
      description: 'Bedrock Knowledge Base service role',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${partition}:bedrock:${region}:${account}:knowledge-base/*` },
        },
      }),
    });

    const policy = new iam.Policy(this, 'ServicePolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'InvokeEmbeddingModel',
          actions: ['bedrock:InvokeModel'],
          resources: [embeddingModelArn],
        }),
        new iam.PolicyStatement({
          sid: 'ListDocumentBucket',
          actions: ['s3:ListBucket'],
          resources: [props.documentBucket.bucketArn],
          conditions: { StringEquals: { 'aws:ResourceAccount': account } },
        }),
        new iam.PolicyStatement({
          sid: 'ReadDocuments',
          actions: ['s3:GetObject'],
          resources: [props.documentBucket.arnForObjects(`${props.documentPrefix}*`)],
          conditions: { StringEquals: { 'aws:ResourceAccount': account } },
        }),
        new iam.PolicyStatement({
          sid: 'ReadWriteVectorIndex',
          actions: ['s3vectors:GetIndex', 's3vectors:PutVectors', 's3vectors:GetVectors', 's3vectors:DeleteVectors', 's3vectors:QueryVectors'],
          resources: [props.vectorStore.index.attrIndexArn],
        }),
        new iam.PolicyStatement({
          sid: 'UseStackKey',
          actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
          resources: [props.key.keyArn],
        }),
      ],
    });
    policy.attachToRole(this.role);

    // Changing the embedding model, dimensions or vector index replaces the
    // knowledge base. CloudFormation creates the replacement before deleting the
    // old one, so the name must change too: suffix a hash of those settings.
    const kbVersion = shortHash([settings.embeddingModelId, settings.embeddingDimensions, settings.distanceMetric]);
    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `${Stack.of(this).stackName}-kb-${kbVersion}`,
      description: props.description,
      roleArn: this.role.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: settings.embeddingDimensions,
              embeddingDataType: 'FLOAT32',
            },
          },
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: { indexArn: props.vectorStore.index.attrIndexArn },
      },
    });
    // Bedrock validates access when the KB is created, so the policy must exist first.
    this.knowledgeBase.node.addDependency(policy);

    this.dataSource = new bedrock.CfnDataSource(this, 'DocumentsDataSource', {
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      // Chunking changes replace the data source; same naming rule as above.
      name: `documents-${shortHash([settings.chunking, props.documentPrefix])}`,
      description: 'S3 document prefix',
      dataDeletionPolicy: settings.dataDeletionPolicy,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: props.documentBucket.bucketArn,
          // Pin the owner so Bedrock never reads a same-named bucket in another account.
          bucketOwnerAccountId: account,
          inclusionPrefixes: [props.documentPrefix],
        },
      },
      // Transient data written during ingestion is encrypted with the stack key.
      serverSideEncryptionConfiguration: { kmsKeyArn: props.key.keyArn },
      vectorIngestionConfiguration: { chunkingConfiguration: chunkingConfiguration(settings.chunking) },
    });
  }

  public get knowledgeBaseArn(): string {
    return this.knowledgeBase.attrKnowledgeBaseArn;
  }
}

/** Stable 8-character hash of replacement-triggering settings. */
export function shortHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8);
}

function chunkingConfiguration(c: KbConfig['knowledgeBase']['chunking']): bedrock.CfnDataSource.ChunkingConfigurationProperty {
  switch (c.strategy) {
    case 'FIXED_SIZE':
      return {
        chunkingStrategy: 'FIXED_SIZE',
        fixedSizeChunkingConfiguration: { maxTokens: c.maxTokens, overlapPercentage: c.overlapPercentage },
      };
    case 'SEMANTIC':
      return {
        chunkingStrategy: 'SEMANTIC',
        semanticChunkingConfiguration: {
          maxTokens: c.maxTokens,
          bufferSize: c.bufferSize,
          breakpointPercentileThreshold: c.breakpointPercentileThreshold,
        },
      };
    case 'NONE':
      return { chunkingStrategy: 'NONE' };
  }
}
