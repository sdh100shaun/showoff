#!/usr/bin/env node
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig } from '../lib/config';
import { KbStack } from '../lib/kb-stack';

const app = new App();
const config = loadConfig({ envName: app.node.tryGetContext('env') as string | undefined });

new KbStack(app, `${config.projectName}-${config.envName}`, {
  config,
  env: { account: config.account, region: config.region },
  description: 'Serverless knowledge base: S3 documents, Bedrock Knowledge Bases, S3 Vectors',
  terminationProtection: config.removalPolicy === 'retain',
});

// AWS Solutions security/best-practice rules run on every synth; unacknowledged
// findings fail synthesis. Acknowledgements (with reasons) live in lib/nag-suppressions.ts.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));
