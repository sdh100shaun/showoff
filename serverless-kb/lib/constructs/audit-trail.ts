import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface AuditTrailProps {
  readonly key: kms.IKey;
  /** 0 = keep indefinitely. */
  readonly archiveRetentionDays: number;
  readonly removalPolicy: RemovalPolicy;
}

/** Event source/detail-type of audit events (kept in sync with src/core/audit.ts). */
export const AUDIT_EVENT_PATTERN = { source: ['kb.retrieval'], detailType: ['ContextServed'] };

/**
 * Audit trail of the context served to agents.
 *
 * Events go to a dedicated, KMS-encrypted EventBridge bus and are archived
 * (replayable). The gateway's audit store (Aurora MySQL in the target
 * architecture) subscribes with its own rule, so this service does not depend
 * on it and nothing is lost before that consumer exists.
 */
export class AuditTrail extends Construct {
  public readonly bus: events.EventBus;

  constructor(scope: Construct, id: string, props: AuditTrailProps) {
    super(scope, id);

    const stack = Stack.of(this);
    // An explicit name lets the key policy reference the bus ARN as a string,
    // avoiding a key ↔ bus dependency cycle.
    const busName = `${stack.stackName}-audit`;
    const busArn = stack.formatArn({ service: 'events', resource: 'event-bus', resourceName: busName });

    this.bus = new events.EventBus(this, 'Bus', {
      eventBusName: busName,
      description: 'Knowledge base audit trail: context served to agents',
      kmsKey: props.key,
    });
    this.bus.applyRemovalPolicy(props.removalPolicy);

    // The L2 Archive grants KMS access via the bus's GetAtt ARN (a cycle with
    // the key), so the archive and its key grant are declared directly.
    props.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEventBridgeAuditArchive',
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:ReEncrypt*', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account, 'kms:EncryptionContext:aws:events:event-bus:arn': busArn },
        },
      }),
    );
    const archive = new events.CfnArchive(this, 'Archive', {
      sourceArn: this.bus.eventBusArn,
      description: 'All ContextServed audit events',
      eventPattern: { source: AUDIT_EVENT_PATTERN.source, 'detail-type': AUDIT_EVENT_PATTERN.detailType },
      retentionDays: props.archiveRetentionDays,
      kmsKeyIdentifier: props.key.keyArn,
    });
    archive.applyRemovalPolicy(props.removalPolicy);
  }

  /** Allows a function to publish audit events (PutEvents on a CMK bus also checks kms:Decrypt). */
  public grantPublish(fn: lambda.IFunction, key: kms.IKey): void {
    this.bus.grantPutEventsTo(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'UseKeyForAuditBus',
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [key.keyArn],
        conditions: { StringEquals: { 'kms:EncryptionContext:aws:events:event-bus:arn': this.bus.eventBusArn } },
      }),
    );
  }
}
