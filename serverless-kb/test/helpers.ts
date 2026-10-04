import { App, Validations } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import * as fs from 'fs';
import * as path from 'path';
import { configSchema, KbConfig } from '../lib/config';
import { KbStack } from '../lib/kb-stack';

export const TEST_ENV = { account: '111111111111', region: 'eu-west-2' };

export function exampleConfig(): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'config.example.json'), 'utf8')) as Record<string, unknown>;
  delete raw.$comment;
  return raw;
}

/** Deep-merges overrides into the example config and validates it. */
export function testConfig(overrides: Record<string, unknown> = {}): KbConfig {
  return configSchema.parse(merge(exampleConfig(), overrides));
}

export function synth(config: KbConfig): { template: Template; app: App; stack: KbStack } {
  // Use the same feature flags as the real app (cdk.json).
  const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8')) as { context: Record<string, unknown> };
  const app = new App({ context: cdkJson.context });
  const stack = new KbStack(app, 'Test', { config, env: TEST_ENV });
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const template = Template.fromStack(stack);
  return { template, app, stack };
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
        ? merge(b as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}
