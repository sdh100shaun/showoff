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
import { AuditTrail } from './constructs/audit-trail';

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
  public readonly audit?: AuditTrail;

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
        eventBridgeEndpoint: config.audit.enabled,
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

    if (config.audit.enabled) {
      this.audit = new AuditTrail(this, 'AuditTrail', { key, archiveRetentionDays: config.audit.archiveRetentionDays, removalPolicy });
    }

    this.network?.restrictEndpointsTo({
      knowledgeBaseArn: this.kb.knowledgeBaseArn,
      trackingTableArn: this.ingestion.trackingTable.tableArn,
      auditBusArn: this.audit?.bus.eventBusArn,
    });

    this.queryApi = new QueryApi(this, 'QueryApi', {
      key,
      knowledgeBaseId: this.kb.knowledgeBase.attrKnowledgeBaseId,
      knowledgeBaseArn: this.kb.knowledgeBaseArn,
      api: config.api,
      generation: config.generation,
      access: config.access,
      audit: this.audit ? { trail: this.audit, failClosed: config.audit.failClosed } : undefined,
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
    if (this.audit) {
      new CfnOutput(this, 'AuditBusName', { value: this.audit.bus.eventBusName, description: 'Subscribe the gateway audit store to ContextServed events here' });
    }

    applyNagSuppressions(this, config);
  }
}
