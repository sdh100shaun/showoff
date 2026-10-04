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
  /** Create an EventBridge endpoint (needed when audit events are enabled). */
  readonly eventBridgeEndpoint: boolean;
}

/**
 * Optional private network: isolated subnets (no internet, no NAT) with
 * PrivateLink interface endpoints for the APIs the Lambdas call (Bedrock,
 * EventBridge for audit events) and a gateway endpoint for DynamoDB. Lambda
 * logging and SQS polling are performed by the Lambda service, so no further
 * endpoints are required.
 */
export class Network extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  private readonly endpoints = new Map<string, ec2.InterfaceVpcEndpoint>();
  private dynamoDbEndpoint: ec2.GatewayVpcEndpoint;

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
      ...(props.eventBridgeEndpoint ? { EventBridge: ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE } : {}),
    };
    for (const [name, service] of Object.entries(services)) {
      this.endpoints.set(
        name,
        this.vpc.addInterfaceEndpoint(name, {
          service,
          privateDnsEnabled: true,
          securityGroups: [endpointSg],
          subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        }),
      );
    }

    // Gateway endpoint (no hourly cost) for the ingestion tracking table.
    this.dynamoDbEndpoint = this.vpc.addGatewayEndpoint('DynamoDb', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });
    // The DynamoDB gateway endpoint is reached by route, not by security group.
    // The subnets have no internet or NAT route, so HTTPS egress can only
    // reach the VPC endpoints.
    this.lambdaSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to VPC endpoints only (no internet route)');
  }

  /** Restrict every endpoint to this account's principals acting on this stack's resources. */
  public restrictEndpointsTo(resources: { knowledgeBaseArn: string; trackingTableArn: string; auditBusArn?: string }): void {
    const { account } = Stack.of(this);
    const inAccount = { StringEquals: { 'aws:PrincipalAccount': account } };
    const allow = (endpoint: ec2.IVpcEndpoint & { addToPolicy(s: iam.PolicyStatement): void }, actions: string[], arns: string[]) =>
      endpoint.addToPolicy(new iam.PolicyStatement({ principals: [new iam.AnyPrincipal()], actions, resources: arns, conditions: inAccount }));

    for (const name of ['BedrockAgentRuntime', 'BedrockAgent']) {
      const endpoint = this.endpoints.get(name)!;
      allow(endpoint, ['bedrock:Retrieve', 'bedrock:StartIngestionJob', 'bedrock:ListIngestionJobs'], [resources.knowledgeBaseArn]);
      // RetrieveAndGenerate has no resource type, so it can only be scoped by principal.
      allow(endpoint, ['bedrock:RetrieveAndGenerate'], ['*']);
    }
    const eventBridge = this.endpoints.get('EventBridge');
    if (eventBridge && resources.auditBusArn) allow(eventBridge, ['events:PutEvents'], [resources.auditBusArn]);
    allow(this.dynamoDbEndpoint, ['dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem'], [resources.trackingTableArn]);
  }
}
