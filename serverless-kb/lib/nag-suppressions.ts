import { Stack, Token, Validations } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';
import { KbConfig } from './config';
import { KbStack } from './kb-stack';

const BASIC_EXECUTION_ROLE = 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]';
const VPC_EXECUTION_ROLE = 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole]';

/**
 * Every cdk-nag acknowledgement in one place, each with its justification, so
 * reviewers can audit accepted risk without hunting through constructs.
 * Acknowledgements are scoped to the narrowest construct possible.
 */
export function applyNagSuppressions(stack: KbStack, config: KbConfig): void {
  const ack = (scope: IConstruct | undefined, id: string, reason: string) => {
    if (scope) Validations.of(scope).acknowledge({ id, reason });
  };

  // --- Lambda execution roles ------------------------------------------------
  for (const fn of [stack.ingestion.function.fn, stack.queryApi.function.fn]) {
    ack(fn.role, BASIC_EXECUTION_ROLE, 'AWSLambdaBasicExecutionRole only grants writing to CloudWatch Logs; the log group is pre-created, KMS-encrypted and retention-managed.');
    ack(fn.role, VPC_EXECUTION_ROLE, 'Required for Lambda to manage ENIs in the isolated subnets when VPC mode is enabled.');
    ack(
      fn.role?.node.tryFindChild('DefaultPolicy'),
      'AwsSolutions-IAM5[Resource::*]',
      'Only xray:PutTraceSegments/PutTelemetryRecords (no resource-level permissions exist for X-Ray) and, when generation is enabled, bedrock:RetrieveAndGenerate (the action has no resource type; access is bounded by bedrock:Retrieve on this KB and InvokeModel on one model).',
    );
  }
  if (config.generation.inferenceProfile) {
    ack(
      stack.queryApi.function.fn.role?.node.tryFindChild('DefaultPolicy'),
      `AwsSolutions::AwsSolutions-IAM5[Resource::arn:${partitionOf(stack)}:bedrock:*::foundation-model/${baseModel(config.generation.modelId)}]`,
      'Cross-region inference profiles route to the base model in several regions; the statement is conditioned on bedrock:InferenceProfileArn equal to this one profile.',
    );
  }
  ack(
    Stack.of(stack).node.tryFindChild('BucketNotificationsHandler050a0587b7544547bf325f094a3db834'),
    BASIC_EXECUTION_ROLE,
    'CDK-managed singleton that enables S3 EventBridge notifications at deploy time; it only writes its own logs.',
  );
  for (const fn of [stack.ingestion.function, stack.queryApi.function]) {
    ack(fn, 'AwsSolutions::AwsSolutions-L1', 'Pinned to nodejs24.x, the latest Node.js LTS Lambda runtime at time of writing; bump deliberately with tests.');
  }

  // --- Network ----------------------------------------------------------------
  if (stack.network) {
    ack(
      stack.network.node.tryFindChild('EndpointSg'),
      'AwsSolutions::AwsSolutions-EC23',
      'Ingress is HTTPS (443) only, from the Lambda security group (not 0.0.0.0/0); nag cannot evaluate the security-group reference.',
    );
  }

  // --- Knowledge base service role --------------------------------------------
  ack(
    stack.kb.node.tryFindChild('ServicePolicy'),
    `AwsSolutions-IAM5[Resource::<${logicalIdOf(stack, stack.documents.bucket)}.Arn>/${config.documents.prefix}*]`,
    'Bedrock must read every document under the configured prefix; access is limited to that prefix in one bucket owned by this account.',
  );

  // --- Cognito ----------------------------------------------------------------
  ack(
    stack.queryApi.userPool,
    'AwsSolutions::AwsSolutions-COG8',
    'Pool has no human users: only the OAuth2 client-credentials grant is enabled. Plus-tier threat protection targets user sign-in and does not apply.',
  );

  // --- API Gateway ------------------------------------------------------------
  if (config.api.executionLogging) {
    ack(
      stack.queryApi.restApi.node.tryFindChild('CloudWatchRole'),
      'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs]',
      'AWS-provided policy for the account-level API Gateway logging role; it only allows writing to CloudWatch Logs.',
    );
  } else {
    ack(
      stack.queryApi.restApi.deploymentStage,
      'AwsSolutions::AwsSolutions-APIG6',
      'Execution logging is opt-in (api.executionLogging) because it changes the account-wide API Gateway CloudWatch role. Access logs, X-Ray tracing, metrics, WAF logs and Lambda logs are always on.',
    );
  }
}

function logicalIdOf(stack: Stack, construct: IConstruct): string {
  const cfn = construct.node.defaultChild;
  if (!cfn) throw new Error(`No default child for ${construct.node.path}`);
  return stack.getLogicalId(cfn as never);
}

function partitionOf(stack: Stack): string {
  return Token.isUnresolved(stack.partition) ? '<AWS::Partition>' : stack.partition;
}

function baseModel(modelId: string | undefined): string {
  return (modelId ?? '').replace(/^(us|eu|apac|us-gov|ca|jp|au|global)\./, '');
}
