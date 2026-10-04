import { Duration } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface MonitoringProps {
  readonly key: kms.IKey;
  readonly api: apigw.RestApi;
  readonly queryFunction: lambda.IFunction;
  readonly ingestFunction: lambda.IFunction;
  readonly deadLetterQueue: sqs.IQueue;
  readonly alarmEmail?: string;
}

/** Operational alarms routed to an encrypted SNS topic. */
export class Monitoring extends Construct {
  public readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    this.topic = new sns.Topic(this, 'AlarmTopic', { masterKey: props.key, enforceSSL: true });
    if (props.alarmEmail) this.topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const action = new actions.SnsAction(this.topic);

    const alarm = (name: string, metric: cloudwatch.IMetric, threshold: number, description: string) => {
      const a = new cloudwatch.Alarm(this, name, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      a.addAlarmAction(action);
      a.addOkAction(action);
    };

    const fiveMin = { period: Duration.minutes(5), statistic: cloudwatch.Stats.SUM };
    alarm('Api5xx', props.api.metricServerError(fiveMin), 5, 'Retrieval API is returning 5xx errors');
    alarm('QueryErrors', props.queryFunction.metricErrors(fiveMin), 5, 'Query Lambda errors');
    alarm('QueryThrottles', props.queryFunction.metricThrottles(fiveMin), 1, 'Query Lambda throttled (reserved concurrency reached)');
    alarm('IngestErrors', props.ingestFunction.metricErrors(fiveMin), 3, 'Ingestion trigger Lambda errors');
    alarm(
      'IngestDlq',
      props.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: cloudwatch.Stats.MAXIMUM }),
      1,
      'Document changes could not be ingested; inspect the dead-letter queue',
    );
  }
}
