import { Match } from 'aws-cdk-lib/assertions';
import { synth, testConfig } from './helpers';

describe('KbStack (default configuration)', () => {
  const { template, app } = synth(testConfig());

  test('passes cdk-nag AwsSolutions checks', () => {
    expect(() => app.synth()).not.toThrow();
  });

  test('customer-managed KMS key with rotation', () => {
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  test('document bucket is private, versioned, KMS-encrypted and TLS-only', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: Match.anyValue() }, BucketKeyEnabled: true }),
        ],
      },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      VersioningConfiguration: { Status: 'Enabled' },
      LoggingConfiguration: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
          Match.objectLike({ Sid: 'DenyNonKmsEncryption', Effect: 'Deny' }),
        ]),
      },
    });
  });

  test('S3 Vectors bucket and index are KMS-encrypted with Bedrock keys non-filterable', () => {
    template.hasResourceProperties('AWS::S3Vectors::VectorBucket', {
      EncryptionConfiguration: { SseType: 'aws:kms', KmsKeyArn: Match.anyValue() },
    });
    template.hasResourceProperties('AWS::S3Vectors::Index', {
      DataType: 'float32',
      Dimension: 1024,
      DistanceMetric: 'cosine',
      MetadataConfiguration: { NonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'] },
    });
  });

  test('knowledge base uses S3 Vectors storage', () => {
    template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      StorageConfiguration: { Type: 'S3_VECTORS', S3VectorsConfiguration: { IndexArn: Match.anyValue() } },
      KnowledgeBaseConfiguration: {
        Type: 'VECTOR',
        VectorKnowledgeBaseConfiguration: Match.objectLike({ EmbeddingModelArn: Match.stringLikeRegexp('amazon.titan-embed-text-v2:0') }),
      },
    });
  });

  test('data source pins bucket owner, prefix and transient-data encryption', () => {
    template.hasResourceProperties('AWS::Bedrock::DataSource', {
      DataSourceConfiguration: {
        Type: 'S3',
        S3Configuration: Match.objectLike({ BucketOwnerAccountId: '111111111111', InclusionPrefixes: ['documents/'] }),
      },
      ServerSideEncryptionConfiguration: { KmsKeyArn: Match.anyValue() },
    });
  });

  test('knowledge base role trust is scoped to this account (confused deputy)', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'bedrock.amazonaws.com' },
            Condition: { StringEquals: { 'aws:SourceAccount': '111111111111' }, ArnLike: Match.anyValue() },
          }),
        ],
      },
    });
  });

  test('retrieve route requires Cognito with the retrieve scope; ask route not deployed', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizationScopes: ['kb-api/retrieve'],
      RequestValidatorId: Match.anyValue(),
    });
    template.resourcePropertiesCountIs('AWS::ApiGateway::Resource', { PathPart: 'ask' }, 0);
  });

  test('app clients use client credentials only, with generated secrets', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: true,
      AllowedOAuthFlows: ['client_credentials'],
      AllowedOAuthFlowsUserPoolClient: true,
    });
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  test('API uses an enhanced TLS policy, tracing and access logs', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      SecurityPolicy: 'SecurityPolicy_TLS13_1_2_2021_06',
      EndpointAccessMode: 'STRICT',
    });
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      TracingEnabled: true,
      AccessLogSetting: Match.anyValue(),
      MethodSettings: [Match.objectLike({ DataTraceEnabled: false })],
    });
  });

  test('WAF is associated, rate-limited and redacts the authorization header in logs', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Rules: Match.arrayWith([Match.objectLike({ Name: 'RateLimitPerIp', Statement: { RateBasedStatement: { Limit: 500, AggregateKeyType: 'IP' } } })]),
    });
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    template.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
      RedactedFields: [{ SingleHeader: { Name: 'authorization' } }],
    });
  });

  test('query Lambda can only Retrieve from its knowledge base', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Sid: 'RetrieveFromKnowledgeBase', Action: 'bedrock:Retrieve', Resource: Match.anyValue() })]),
      },
    });
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('bedrock:RetrieveAndGenerate');
    expect(policies).not.toContain('"bedrock:*"');
  });

  test('all log groups are KMS-encrypted with retention', () => {
    const groups = template.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(groups).length).toBeGreaterThan(0);
    for (const g of Object.values(groups)) {
      expect(g.Properties.KmsKeyId).toBeDefined();
      expect(g.Properties.RetentionInDays).toBe(90);
    }
  });

  test('queues are KMS-encrypted with a DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      KmsMasterKeyId: Match.anyValue(),
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 12 }),
    });
  });

  test('Lambdas do not run in a VPC by default and log queries is off', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ LOG_QUERIES: 'false' }) },
      TracingConfig: { Mode: 'Active' },
    });
    template.resourceCountIs('AWS::EC2::VPC', 0);
  });

  test('no hard-coded account id other than the synth-time environment', () => {
    const json = JSON.stringify(template.toJSON());
    const ids = new Set(json.match(/\b\d{12}\b/g) ?? []);
    ids.delete('111111111111');
    expect([...ids]).toEqual([]);
  });
});

describe('KbStack (VPC, generation via inference profile, guardrail, execution logging)', () => {
  const config = testConfig({
    network: { enableVpc: true },
    generation: {
      enabled: true,
      modelId: 'eu.example.model-v1:0',
      inferenceProfile: true,
      guardrailId: 'abc123',
      guardrailVersion: '1',
    },
    api: { executionLogging: true, clients: [{ name: 'agent', scopes: ['retrieve', 'ask'] }] },
  });
  const { template, app } = synth(config);

  test('passes cdk-nag AwsSolutions checks', () => {
    expect(() => app.synth()).not.toThrow();
  });

  test('deploys the ask route with its own scope', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', { AuthorizationScopes: ['kb-api/ask'] });
  });

  test('model access is restricted to the inference profile', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'InvokeModelViaProfile',
            Resource: Match.anyValue(),
            Condition: { StringEquals: { 'bedrock:InferenceProfileArn': Match.anyValue() } },
          }),
          Match.objectLike({ Sid: 'ApplyGuardrail' }),
        ]),
      },
    });
  });

  test('isolated VPC with Bedrock PrivateLink endpoints and no NAT', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::InternetGateway', 0);
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 2);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: 'com.amazonaws.eu-west-2.bedrock-agent-runtime',
      PrivateDnsEnabled: true,
      PolicyDocument: Match.objectLike({ Statement: Match.anyValue() }),
    });
    template.hasResourceProperties('AWS::Lambda::Function', { VpcConfig: Match.anyValue() });
    template.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'ALL' });
  });

  test('execution logging enabled without data tracing', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: [Match.objectLike({ LoggingLevel: 'ERROR', DataTraceEnabled: false })],
    });
  });
});
