import { CfnOutput, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { KbConfig } from './config';
import { DocumentStore } from './constructs/document-store';
import { Encryption } from './constructs/encryption';
import { Ingestion } from './constructs/ingestion';
import { KnowledgeBase } from './constructs/knowledge-base';
import { Monitoring } from './constructs/monitoring';
import { Network } from './constructs/network';
import { QueryApi } from './constructs/query-api';
import { VectorStore } from './constructs/vector-store';
import { applyNagSuppressions } from './nag-suppressions';

export interface KbStackProps extends StackProps {
  readonly config: KbConfig;
}

export class KbStack extends Stack {
  public readonly encryption: Encryption;
  public readonly documents: DocumentStore;
  public readonly vectors: VectorStore;
  public readonly kb: KnowledgeBase;
  public readonly ingestion: Ingestion;
  public readonly queryApi: QueryApi;
  public readonly network?: Network;

  constructor(scope: Construct, id: string, props: KbStackProps) {
    super(scope, id, props);
    const { config } = props;

    const removalPolicy = config.removalPolicy === 'retain' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const logRetention = config.observability.logRetentionDays as logs.RetentionDays;

    Tags.of(this).add('Project', config.projectName);
    Tags.of(this).add('Environment', config.envName);
    for (const [k, v] of Object.entries(config.tags)) Tags.of(this).add(k, v);

    this.encryption = new Encryption(this, 'Encryption', { removalPolicy });
    const key = this.encryption.key;

    if (config.network.enableVpc) {
      this.network = new Network(this, 'Network', {
        cidr: config.network.vpcCidr,
        maxAzs: config.network.maxAzs,
        key,
        logRetention,
        removalPolicy,
      });
    }
    const vpcPlacement = this.network ? { vpc: this.network.vpc, securityGroup: this.network.lambdaSecurityGroup } : {};

    this.documents = new DocumentStore(this, 'DocumentStore', {
      key,
      removalPolicy,
      noncurrentVersionExpirationDays: config.documents.noncurrentVersionExpirationDays,
      accessLogExpirationDays: config.documents.accessLogExpirationDays,
      writerPrincipalArns: config.documents.writerPrincipalArns,
    });

    this.vectors = new VectorStore(this, 'VectorStore', {
      key,
      dimension: config.knowledgeBase.embeddingDimensions,
      distanceMetric: config.knowledgeBase.distanceMetric,
      removalPolicy,
    });

    this.kb = new KnowledgeBase(this, 'KnowledgeBase', {
      key,
      documentBucket: this.documents.bucket,
      documentPrefix: config.documents.prefix,
      vectorStore: this.vectors,
      settings: config.knowledgeBase,
      description: `${config.projectName} ${config.envName} knowledge base`,
    });
    this.network?.restrictEndpointsTo(this.kb.knowledgeBaseArn);

    this.ingestion = new Ingestion(this, 'Ingestion', {
      key,
      documentBucket: this.documents.bucket,
      documentPrefix: config.documents.prefix,
      knowledgeBaseId: this.kb.knowledgeBase.attrKnowledgeBaseId,
      knowledgeBaseArn: this.kb.knowledgeBaseArn,
      dataSourceId: this.kb.dataSource.attrDataSourceId,
      settings: config.ingestion,
      logRetention,
      removalPolicy,
      ...vpcPlacement,
    });

    this.queryApi = new QueryApi(this, 'QueryApi', {
      key,
      knowledgeBaseId: this.kb.knowledgeBase.attrKnowledgeBaseId,
      knowledgeBaseArn: this.kb.knowledgeBaseArn,
      api: config.api,
      generation: config.generation,
      logQueries: config.observability.logQueries,
      logRetention,
      removalPolicy,
      ...vpcPlacement,
    });

    new Monitoring(this, 'Monitoring', {
      key,
      api: this.queryApi.restApi,
      queryFunction: this.queryApi.function.fn,
      ingestFunction: this.ingestion.function.fn,
      deadLetterQueue: this.ingestion.deadLetterQueue,
      alarmEmail: config.observability.alarmEmail,
    });

    new CfnOutput(this, 'DocumentBucketName', { value: this.documents.bucket.bucketName, description: `Upload documents under s3://<bucket>/${config.documents.prefix}` });
    new CfnOutput(this, 'KnowledgeBaseId', { value: this.kb.knowledgeBase.attrKnowledgeBaseId });
    new CfnOutput(this, 'DataSourceId', { value: this.kb.dataSource.attrDataSourceId });

    applyNagSuppressions(this, config);
  }
}
