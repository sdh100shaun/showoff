import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface NetworkProps {
  readonly cidr: string;
  readonly maxAzs: number;
  readonly key: kms.IKey;
  readonly logRetention: logs.RetentionDays;
  readonly removalPolicy: RemovalPolicy;
}

/**
 * Optional private network: isolated subnets (no internet, no NAT) with
 * PrivateLink interface endpoints for the Bedrock APIs the Lambdas call.
 * Lambda logging and SQS polling are performed by the Lambda service, so no
 * further endpoints are required.
 */
export class Network extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  private readonly endpoints: ec2.InterfaceVpcEndpoint[] = [];

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id);

    const flowLogGroup = new logs.LogGroup(this, 'FlowLogs', {
      encryptionKey: props.key,
      retention: props.logRetention,
      removalPolicy: props.removalPolicy,
    });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      maxAzs: props.maxAzs,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 26 }],
      restrictDefaultSecurityGroup: true,
      flowLogs: {
        all: { destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup), trafficType: ec2.FlowLogTrafficType.ALL },
      },
    });

    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'Knowledge base Lambdas: HTTPS to VPC endpoints only',
      allowAllOutbound: false,
    });

    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      description: 'Interface endpoints: HTTPS from knowledge base Lambdas',
      allowAllOutbound: false,
    });
    endpointSg.addIngressRule(this.lambdaSecurityGroup, ec2.Port.tcp(443), 'HTTPS from Lambdas');
    this.lambdaSecurityGroup.addEgressRule(endpointSg, ec2.Port.tcp(443), 'HTTPS to VPC endpoints');

    const services: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      BedrockAgentRuntime: ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENT_RUNTIME,
      BedrockAgent: ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENT,
    };
    for (const [name, service] of Object.entries(services)) {
      this.endpoints.push(
        this.vpc.addInterfaceEndpoint(name, {
          service,
          privateDnsEnabled: true,
          securityGroups: [endpointSg],
          subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        }),
      );
    }
  }

  /** Restrict the endpoints to this account's principals acting on one knowledge base. */
  public restrictEndpointsTo(knowledgeBaseArn: string): void {
    const { account } = Stack.of(this);
    for (const endpoint of this.endpoints) {
      endpoint.addToPolicy(
        new iam.PolicyStatement({
          principals: [new iam.AnyPrincipal()],
          actions: ['bedrock:Retrieve', 'bedrock:StartIngestionJob', 'bedrock:ListIngestionJobs'],
          resources: [knowledgeBaseArn],
          conditions: { StringEquals: { 'aws:PrincipalAccount': account } },
        }),
      );
      // RetrieveAndGenerate has no resource type, so it can only be scoped by principal.
      endpoint.addToPolicy(
        new iam.PolicyStatement({
          principals: [new iam.AnyPrincipal()],
          actions: ['bedrock:RetrieveAndGenerate'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:PrincipalAccount': account } },
        }),
      );
    }
  }
}
