import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../lib/config';
import { exampleConfig } from './helpers';

function writeConfig(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbcfg-'));
  const file = path.join(dir, 'test.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

describe('loadConfig', () => {
  test('the committed example config is valid', () => {
    const cfg = loadConfig({ configFile: writeConfig(exampleConfig()), env: {} });
    expect(cfg.projectName).toBe('kb-pilot');
    expect(cfg.region).toBe('eu-west-2');
    expect(cfg.account).toBeUndefined();
    expect(cfg.knowledgeBase.embeddingDimensions).toBe(1024);
    expect(cfg.observability.logQueries).toBe(false);
  });

  test('the example config contains no account id or email', () => {
    const text = JSON.stringify(exampleConfig());
    expect(text).not.toMatch(/\d{12}/);
    expect(text).not.toMatch(/@/);
  });

  test('requires a selection', () => {
    expect(() => loadConfig({ env: {} })).toThrow(/No configuration selected/);
  });

  test('reports a missing file clearly', () => {
    expect(() => loadConfig({ envName: 'nope', configDir: os.tmpdir(), env: {} })).toThrow(/Config file not found/);
  });

  test('falls back to CDK_DEFAULT_ACCOUNT/REGION', () => {
    const raw = exampleConfig();
    delete raw.region;
    const cfg = loadConfig({ configFile: writeConfig(raw), env: { CDK_DEFAULT_ACCOUNT: '222222222222', CDK_DEFAULT_REGION: 'eu-west-1' } });
    expect(cfg.account).toBe('222222222222');
    expect(cfg.region).toBe('eu-west-1');
  });

  test('KB_* environment overrides take precedence', () => {
    const cfg = loadConfig({
      configFile: writeConfig(exampleConfig()),
      env: { KB_ACCOUNT: '333333333333', KB_REGION: 'us-east-1', KB_ALARM_EMAIL: 'ops@example.com', KB_COGNITO_DOMAIN_PREFIX: 'my-prefix' },
    });
    expect(cfg.account).toBe('333333333333');
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.observability.alarmEmail).toBe('ops@example.com');
    expect(cfg.api.cognitoDomainPrefix).toBe('my-prefix');
  });

  test('EU inference profiles are allowed by default; others only when opted in', () => {
    const eu = { ...exampleConfig(), generation: { enabled: true, inferenceProfile: true, modelId: 'eu.vendor.model-v1:0' } };
    expect(loadConfig({ configFile: writeConfig(eu), env: {} }).generation.modelId).toBe('eu.vendor.model-v1:0');
    const global = {
      ...exampleConfig(),
      generation: { enabled: true, inferenceProfile: true, modelId: 'global.vendor.model-v1:0', allowedInferenceGeographies: ['eu', 'global'] },
    };
    expect(() => loadConfig({ configFile: writeConfig(global), env: {} })).not.toThrow();
  });

  test('open access mode needs no groups (single trust domain)', () => {
    const open = {
      ...exampleConfig(),
      access: { mode: 'open' },
      api: { ...(exampleConfig().api as object), clients: [{ name: 'agent-x', scopes: ['retrieve'] }] },
    };
    expect(loadConfig({ configFile: writeConfig(open), env: {} }).access.mode).toBe('open');
  });

  test.each([
    ['unknown top-level key', { surprise: true }, /Unrecognized key|unrecognized/i],
    ['bad account', { account: '123' }, /12-digit/],
    ['double hyphen in project name', { projectName: 'kb--pilot' }, /single hyphens/],
    ['non-ARN document writer', { documents: { writerPrincipalArns: ['admin'] } }, /IAM role\/user ARN/],
    ['bad region', { region: 'london' }, /region/],
    ['prefix without slash', { documents: { prefix: 'docs' } }, /ending in \//],
    ['generation without model', { generation: { enabled: true } }, /modelId is required/],
    ['guardrail id without version', { generation: { guardrailId: 'abc' } }, /set together/],
    ['invalid log retention', { observability: { logRetentionDays: 42 } }, /logRetentionDays/],
    ['bad filter key', { api: { ...(exampleConfig().api as object), allowedFilterKeys: ['bad key!'] } }, /metadata keys/],
    ['groups mode without groups', { access: { mode: 'groups', groups: [] } }, /at least one access group/],
    ['client with an unknown group', { access: { groups: ['general'] } }, /unknown access group "finance"/],
    ['client without groups', { api: { ...(exampleConfig().api as object), clients: [{ name: 'agent-x', scopes: ['retrieve'] }] } }, /each client needs at least one access group/],
    ['the access key as a caller filter', { api: { ...(exampleConfig().api as object), allowedFilterKeys: ['access_group'] } }, /enforced from the token/],
    ['a global inference profile by default', { generation: { enabled: true, inferenceProfile: true, modelId: 'global.vendor.model-v1:0' } }, /data residency/],
    ['a US inference profile by default', { generation: { enabled: true, inferenceProfile: true, modelId: 'us.vendor.model-v1:0' } }, /data residency/],
  ])('rejects %s', (_name, override, message) => {
    const file = writeConfig({ ...exampleConfig(), ...override });
    expect(() => loadConfig({ configFile: file, env: {} })).toThrow(message);
  });
});
