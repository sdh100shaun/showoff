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

  test.each([
    ['unknown top-level key', { surprise: true }, /Unrecognized key|unrecognized/i],
    ['bad account', { account: '123' }, /12-digit/],
    ['bad region', { region: 'london' }, /region/],
    ['prefix without slash', { documents: { prefix: 'docs' } }, /ending in \//],
    ['generation without model', { generation: { enabled: true } }, /modelId is required/],
    ['guardrail id without version', { generation: { guardrailId: 'abc' } }, /set together/],
    ['invalid log retention', { observability: { logRetentionDays: 42 } }, /logRetentionDays/],
    ['bad filter key', { api: { ...(exampleConfig().api as object), allowedFilterKeys: ['bad key!'] } }, /metadata keys/],
  ])('rejects %s', (_name, override, message) => {
    const file = writeConfig({ ...exampleConfig(), ...override });
    expect(() => loadConfig({ configFile: file, env: {} })).toThrow(message);
  });
});
