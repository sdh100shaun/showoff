import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface SecureFunctionProps {
  /** Handler file name in src/handlers (without extension). */
  readonly handler: string;
  readonly description: string;
  readonly key: kms.IKey;
  readonly logRetention: logs.RetentionDays;
  readonly removalPolicy: RemovalPolicy;
  readonly environment: Record<string, string>;
  readonly timeout: Duration;
  readonly memorySize?: number;
  readonly reservedConcurrentExecutions?: number;
  readonly vpc?: ec2.IVpc;
  readonly securityGroup?: ec2.ISecurityGroup;
}

/**
 * Node.js Lambda with consistent hardening: arm64, current runtime,
 * KMS-encrypted environment and log group, X-Ray tracing, bundled and pinned
 * AWS SDK clients, and optional VPC placement.
 */
export class SecureFunction extends Construct {
  public readonly fn: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: SecureFunctionProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'Logs', {
      encryptionKey: props.key,
      retention: props.logRetention,
      removalPolicy: props.removalPolicy,
    });

    this.fn = new nodejs.NodejsFunction(this, 'Function', {
      entry: path.join(__dirname, '..', '..', 'src', 'handlers', `${props.handler}.ts`),
      handler: 'handler',
      description: props.description,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize ?? 512,
      timeout: props.timeout,
      reservedConcurrentExecutions: props.reservedConcurrentExecutions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      environment: { NODE_OPTIONS: '--enable-source-maps', ...props.environment },
      environmentEncryption: props.key,
      vpc: props.vpc,
      vpcSubnets: props.vpc ? { subnetType: ec2.SubnetType.PRIVATE_ISOLATED } : undefined,
      securityGroups: props.securityGroup ? [props.securityGroup] : undefined,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node24',
        // Bundle the AWS SDK so the deployed client version matches what was tested.
        externalModules: [],
        forceDockerBundling: false,
      },
    });
  }
}
