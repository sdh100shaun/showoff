import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { baseModelId, KbConfig } from '../config';
import { AuditTrail } from './audit-trail';
import { SecureFunction } from './secure-function';

export interface QueryApiProps {
  readonly key: kms.IKey;
  readonly knowledgeBaseId: string;
  readonly knowledgeBaseArn: string;
  readonly api: KbConfig['api'];
  readonly generation: KbConfig['generation'];
  readonly access: KbConfig['access'];
  readonly audit?: { trail: AuditTrail; failClosed: boolean };
  readonly logQueries: boolean;
  readonly logRetention: logs.RetentionDays;
  readonly removalPolicy: RemovalPolicy;
  readonly vpc?: ec2.IVpc;
  readonly securityGroup?: ec2.ISecurityGroup;
}

type Scope = 'retrieve' | 'ask';

/**
 * Authenticated retrieval API for the gateway, orchestrator and agents.
 *
 * Callers obtain an OAuth2 access token with the client-credentials grant from
 * Cognito and call API Gateway with it. Each route requires its own scope, and
 * `group:<name>` scopes set the ceiling of access groups the client may read.
 * Routes: POST /retrieve, POST /ask (optional), POST /mcp (MCP Streamable HTTP).
 * WAF, throttling and request validation sit in front of the Lambda.
 */
export class QueryApi extends Construct {
  public readonly restApi: apigw.RestApi;
  public readonly userPool: cognito.UserPool;
  public readonly function: SecureFunction;
  public readonly webAcl?: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: QueryApiProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { api, generation } = props;

    // ---------------------------------------------------------------- auth
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      // Machine-to-machine only: no sign-up, no recovery, no user attributes.
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 16,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(1),
      },
      deletionProtection: props.removalPolicy === RemovalPolicy.RETAIN,
      removalPolicy: props.removalPolicy,
    });

    const domain = this.userPool.addDomain('Domain', { cognitoDomain: { domainPrefix: api.cognitoDomainPrefix } });

    const scopes: Record<Scope, cognito.ResourceServerScope> = {
      retrieve: new cognito.ResourceServerScope({ scopeName: 'retrieve', scopeDescription: 'Retrieve context chunks' }),
      ask: new cognito.ResourceServerScope({ scopeName: 'ask', scopeDescription: 'Generate grounded answers' }),
    };
    // One scope per access group: the token itself carries the client's group ceiling.
    const groupScopes = new Map(
      (props.access.mode === 'groups' ? props.access.groups : []).map((g) => [
        g,
        new cognito.ResourceServerScope({ scopeName: `group:${g}`, scopeDescription: `Read documents in access group ${g}` }),
      ]),
    );
    const delegatedScope = api.clients.some((c) => c.delegating)
      ? new cognito.ResourceServerScope({ scopeName: 'delegated', scopeDescription: 'Acts for end users; identity headers required' })
      : undefined;
    const resourceServer = this.userPool.addResourceServer('ResourceServer', {
      identifier: api.resourceServerIdentifier,
      scopes: [...Object.values(scopes), ...groupScopes.values(), ...(delegatedScope ? [delegatedScope] : [])],
    });

    for (const client of api.clients) {
      const c = this.userPool.addClient(`Client-${client.name}`, {
        userPoolClientName: client.name,
        generateSecret: true,
        authFlows: {},
        oAuth: {
          flows: { clientCredentials: true },
          scopes: [
            ...client.scopes.map((s) => cognito.OAuthScope.resourceServer(resourceServer, scopes[s])),
            ...client.accessGroups.filter((g) => groupScopes.has(g)).map((g) => cognito.OAuthScope.resourceServer(resourceServer, groupScopes.get(g)!)),
            ...(client.delegating && delegatedScope ? [cognito.OAuthScope.resourceServer(resourceServer, delegatedScope)] : []),
          ],
        },
        accessTokenValidity: Duration.minutes(api.accessTokenValidityMinutes),
        enableTokenRevocation: true,
        preventUserExistenceErrors: true,
      });
      // The client id is not a secret; the secret stays in Cognito and is never output.
      new CfnOutput(stack, `ClientId${toPascal(client.name)}`, { value: c.userPoolClientId, description: `App client id for ${client.name}` });
    }

    // -------------------------------------------------------------- lambda
    const modelArn = generation.enabled && generation.modelId ? generationModelArn(stack, generation.modelId, generation.inferenceProfile) : undefined;

    this.function = new SecureFunction(this, 'Query', {
      handler: 'query',
      description: 'Retrieves context from the Bedrock knowledge base',
      key: props.key,
      logRetention: props.logRetention,
      removalPolicy: props.removalPolicy,
      timeout: Duration.seconds(29),
      memorySize: 512,
      reservedConcurrentExecutions: api.reservedConcurrency > 0 ? api.reservedConcurrency : undefined,
      environment: {
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        MAX_QUERY_LENGTH: String(api.maxQueryLength),
        MAX_RESULTS: String(api.maxResults),
        MAX_TOKEN_BUDGET: String(api.maxTokenBudget),
        ALLOWED_FILTER_KEYS: api.allowedFilterKeys.join(','),
        ACCESS_MODE: props.access.mode,
        ACCESS_METADATA_KEY: props.access.metadataKey,
        AUDIT_FAIL_CLOSED: String(props.audit?.failClosed ?? true),
        ...(props.audit ? { AUDIT_BUS_NAME: props.audit.trail.bus.eventBusName } : {}),
        LOG_QUERIES: String(props.logQueries),
        REQUIRED_SCOPE_PREFIX: api.resourceServerIdentifier,
        POWERTOOLS_SERVICE_NAME: 'kb-query',
        ...(modelArn ? { GENERATION_MODEL_ARN: modelArn } : {}),
        ...(generation.guardrailId && generation.guardrailVersion
          ? { GUARDRAIL_ID: generation.guardrailId, GUARDRAIL_VERSION: generation.guardrailVersion }
          : {}),
      },
      vpc: props.vpc,
      securityGroup: props.securityGroup,
    });

    this.function.fn.addToRolePolicy(
      new iam.PolicyStatement({ sid: 'RetrieveFromKnowledgeBase', actions: ['bedrock:Retrieve'], resources: [props.knowledgeBaseArn] }),
    );
    props.audit?.trail.grantPublish(this.function.fn, props.key);
    if (generation.enabled && generation.modelId) {
      this.grantGeneration(stack, generation.modelId, generation.inferenceProfile, generation.guardrailId);
    }

    // ----------------------------------------------------------------- api
    const accessLogs = new logs.LogGroup(this, 'AccessLogs', {
      encryptionKey: props.key,
      retention: props.logRetention,
      removalPolicy: props.removalPolicy,
    });

    this.restApi = new apigw.RestApi(this, 'Api', {
      description: 'Knowledge base retrieval API',
      endpointTypes: [apigw.EndpointType.REGIONAL],
      cloudWatchRole: api.executionLogging,
      ...(api.executionLogging ? { cloudWatchRoleRemovalPolicy: props.removalPolicy } : {}),
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: api.executionLogging ? apigw.MethodLoggingLevel.ERROR : apigw.MethodLoggingLevel.OFF,
        // Never log request/response bodies: they contain queries and document text.
        dataTraceEnabled: false,
        throttlingRateLimit: api.throttleRateLimit,
        throttlingBurstLimit: api.throttleBurstLimit,
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
      },
    });

    // Enforce a modern TLS policy on the execute-api endpoint.
    const cfnApi = this.restApi.node.defaultChild as apigw.CfnRestApi;
    if (api.securityPolicy !== 'TLS_1_2') {
      cfnApi.securityPolicy = api.securityPolicy;
      cfnApi.endpointAccessMode = 'STRICT';
    } else {
      cfnApi.securityPolicy = 'TLS_1_2';
    }

    // Uniform, minimal error bodies with hardening headers.
    const securityHeaders = {
      'Strict-Transport-Security': "'max-age=63072000; includeSubDomains'",
      'X-Content-Type-Options': "'nosniff'",
      'Cache-Control': "'no-store'",
    };
    for (const type of [apigw.ResponseType.DEFAULT_4XX, apigw.ResponseType.DEFAULT_5XX]) {
      this.restApi.addGatewayResponse(`Gw${type.responseType}`, {
        type,
        responseHeaders: securityHeaders,
        templates: { 'application/json': '{"message":$context.error.messageString,"requestId":"$context.requestId"}' },
      });
    }

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Authorizer', { cognitoUserPools: [this.userPool] });
    const validator = new apigw.RequestValidator(this, 'BodyValidator', {
      restApi: this.restApi,
      validateRequestBody: true,
      validateRequestParameters: true,
    });
    const model = this.restApi.addModel('QueryRequest', {
      contentType: 'application/json',
      schema: requestSchema(api),
    });
    const integration = new apigw.LambdaIntegration(this.function.fn, { proxy: true, allowTestInvoke: false });

    const route = (path: string, scope: Scope) =>
      this.restApi.root.addResource(path).addMethod('POST', integration, {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
        authorizationScopes: [`${api.resourceServerIdentifier}/${scope}`],
        requestValidator: validator,
        requestModels: { 'application/json': model },
      });
    route('retrieve', 'retrieve');
    if (generation.enabled) route('ask', 'ask');

    if (api.mcpEnabled) {
      // MCP Streamable HTTP. Any capability scope may connect; tools are
      // filtered and enforced per scope inside the Lambda.
      const mcpScopes = [`${api.resourceServerIdentifier}/retrieve`, ...(generation.enabled ? [`${api.resourceServerIdentifier}/ask`] : [])];
      const mcpModel = this.restApi.addModel('McpRequest', {
        contentType: 'application/json',
        schema: {
          schema: apigw.JsonSchemaVersion.DRAFT4,
          title: 'McpRequest',
          type: apigw.JsonSchemaType.OBJECT,
          required: ['jsonrpc', 'method'],
          properties: {
            jsonrpc: { type: apigw.JsonSchemaType.STRING, enum: ['2.0'] },
            method: { type: apigw.JsonSchemaType.STRING, maxLength: 128 },
          },
        },
      });
      const mcp = this.restApi.root.addResource('mcp');
      mcp.addMethod('POST', integration, {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
        authorizationScopes: mcpScopes,
        requestValidator: validator,
        requestModels: { 'application/json': mcpModel },
      });
      // Returns 405: this server offers no SSE stream (allowed by the spec).
      mcp.addMethod('GET', integration, { authorizer, authorizationType: apigw.AuthorizationType.COGNITO, authorizationScopes: mcpScopes });
    }

    // ----------------------------------------------------------------- waf
    if (api.waf.enabled) {
      this.webAcl = this.createWebAcl(api.waf.rateLimitPer5Min, props);
      new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
        resourceArn: this.restApi.deploymentStage.stageArn,
        webAclArn: this.webAcl.attrArn,
      });
      // The OAuth2 token endpoint is public too: rate-limit it to slow
      // client-secret guessing.
      new wafv2.CfnWebACLAssociation(this, 'UserPoolWebAclAssociation', {
        resourceArn: this.userPool.userPoolArn,
        webAclArn: this.webAcl.attrArn,
      });
    }

    new CfnOutput(stack, 'ApiUrl', { value: this.restApi.url, description: 'Base URL of the retrieval API' });
    new CfnOutput(stack, 'TokenEndpoint', { value: `${domain.baseUrl()}/oauth2/token`, description: 'OAuth2 token endpoint (client credentials)' });
    new CfnOutput(stack, 'UserPoolId', { value: this.userPool.userPoolId });
  }

  private grantGeneration(stack: Stack, modelId: string, inferenceProfile: boolean, guardrailId?: string): void {
    const role = this.function.fn;
    // RetrieveAndGenerate has no resource type in IAM; it is scoped by the
    // Retrieve and InvokeModel permissions it relies on.
    role.addToRolePolicy(new iam.PolicyStatement({ sid: 'RetrieveAndGenerate', actions: ['bedrock:RetrieveAndGenerate'], resources: ['*'] }));

    if (inferenceProfile) {
      const profileArn = `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:inference-profile/${modelId}`;
      role.addToRolePolicy(
        new iam.PolicyStatement({ sid: 'InvokeInferenceProfile', actions: ['bedrock:InvokeModel', 'bedrock:GetInferenceProfile'], resources: [profileArn] }),
      );
      // Cross-region profiles route to the base model in several regions; only via this profile.
      role.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'InvokeModelViaProfile',
          actions: ['bedrock:InvokeModel'],
          resources: [`arn:${stack.partition}:bedrock:*::foundation-model/${baseModelId(modelId)}`],
          conditions: { StringEquals: { 'bedrock:InferenceProfileArn': profileArn } },
        }),
      );
    } else {
      role.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'InvokeModel',
          actions: ['bedrock:InvokeModel'],
          resources: [`arn:${stack.partition}:bedrock:${stack.region}::foundation-model/${modelId}`],
        }),
      );
    }

    if (guardrailId) {
      role.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'ApplyGuardrail',
          actions: ['bedrock:ApplyGuardrail'],
          resources: [`arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:guardrail/${guardrailId}`],
        }),
      );
    }
  }

  private createWebAcl(rateLimit: number, props: QueryApiProps): wafv2.CfnWebACL {
    const stack = Stack.of(this);
    const managed = (name: string, priority: number): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: false },
    });

    const acl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'kb-api', sampledRequestsEnabled: false },
      rules: [
        {
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: rateLimit, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'RateLimitPerIp', sampledRequestsEnabled: false },
        },
        managed('AWSManagedRulesAmazonIpReputationList', 1),
        managed('AWSManagedRulesCommonRuleSet', 2),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 3),
      ],
    });

    // WAF requires the log group name to start with "aws-waf-logs-".
    const wafLogs = new logs.LogGroup(this, 'WafLogs', {
      logGroupName: `aws-waf-logs-${stack.stackName}`,
      encryptionKey: props.key,
      retention: props.logRetention,
      removalPolicy: props.removalPolicy,
    });
    new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
      resourceArn: acl.attrArn,
      logDestinationConfigs: [
        stack.formatArn({ service: 'logs', resource: 'log-group', resourceName: wafLogs.logGroupName, arnFormat: ArnFormat.COLON_RESOURCE_NAME }),
      ],
      // Never write bearer tokens to logs.
      redactedFields: [{ singleHeader: { Name: 'authorization' } }],
    });
    return acl;
  }
}

/** JSON schema (draft 4) enforced by API Gateway before the Lambda runs. */
function requestSchema(api: KbConfig['api']): apigw.JsonSchema {
  const properties: Record<string, apigw.JsonSchema> = {
    query: { type: apigw.JsonSchemaType.STRING, minLength: 1, maxLength: api.maxQueryLength },
    maxResults: { type: apigw.JsonSchemaType.INTEGER, minimum: 1, maximum: api.maxResults },
    maxTokens: { type: apigw.JsonSchemaType.INTEGER, minimum: 1, maximum: api.maxTokenBudget },
  };
  if (api.allowedFilterKeys.length > 0) {
    const value: apigw.JsonSchema = {
      oneOf: [
        { type: apigw.JsonSchemaType.STRING, maxLength: 256 },
        { type: apigw.JsonSchemaType.ARRAY, items: { type: apigw.JsonSchemaType.STRING, maxLength: 256 }, minItems: 1, maxItems: 10 },
      ],
    };
    properties.filter = {
      type: apigw.JsonSchemaType.OBJECT,
      additionalProperties: false,
      minProperties: 1,
      properties: Object.fromEntries(api.allowedFilterKeys.map((k) => [k, value])),
    };
  }
  return {
    schema: apigw.JsonSchemaVersion.DRAFT4,
    title: 'QueryRequest',
    type: apigw.JsonSchemaType.OBJECT,
    required: ['query'],
    additionalProperties: false,
    properties,
  };
}

function generationModelArn(stack: Stack, modelId: string, inferenceProfile: boolean): string {
  return inferenceProfile
    ? `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:inference-profile/${modelId}`
    : `arn:${stack.partition}:bedrock:${stack.region}::foundation-model/${modelId}`;
}

function toPascal(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}
