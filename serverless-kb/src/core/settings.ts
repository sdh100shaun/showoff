/** Query Lambda settings, read and validated once per cold start. */
export interface Settings {
  knowledgeBaseId: string;
  scopePrefix: string;
  maxQueryLength: number;
  maxResults: number;
  maxTokenBudget: number;
  allowedFilterKeys: string[];
  access: { mode: 'groups' | 'open'; metadataKey: string };
  audit: { busName?: string; failClosed: boolean };
  generation?: { modelArn: string; guardrail?: { guardrailId: string; guardrailVersion: string } };
  logQueries: boolean;
}

export function settingsFromEnv(env: NodeJS.ProcessEnv): Settings {
  const mode = env.ACCESS_MODE ?? 'groups';
  if (mode !== 'groups' && mode !== 'open') throw new Error('Invalid ACCESS_MODE');
  return {
    knowledgeBaseId: required(env, 'KNOWLEDGE_BASE_ID'),
    scopePrefix: required(env, 'REQUIRED_SCOPE_PREFIX'),
    maxQueryLength: int(env, 'MAX_QUERY_LENGTH', 1, 8000),
    maxResults: int(env, 'MAX_RESULTS', 1, 100),
    maxTokenBudget: int(env, 'MAX_TOKEN_BUDGET', 100, 100_000),
    allowedFilterKeys: list(env.ALLOWED_FILTER_KEYS),
    access: { mode, metadataKey: required(env, 'ACCESS_METADATA_KEY') },
    audit: { busName: env.AUDIT_BUS_NAME || undefined, failClosed: env.AUDIT_FAIL_CLOSED !== 'false' },
    generation: env.GENERATION_MODEL_ARN
      ? {
          modelArn: env.GENERATION_MODEL_ARN,
          guardrail:
            env.GUARDRAIL_ID && env.GUARDRAIL_VERSION ? { guardrailId: env.GUARDRAIL_ID, guardrailVersion: env.GUARDRAIL_VERSION } : undefined,
        }
      : undefined,
    logQueries: env.LOG_QUERIES === 'true',
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

function int(env: NodeJS.ProcessEnv, name: string, min: number, max: number): number {
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
