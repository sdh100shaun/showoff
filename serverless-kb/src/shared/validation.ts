import type { RetrievalFilter } from '@aws-sdk/client-bedrock-agent-runtime';
import { z } from 'zod';

export interface QuerySettings {
  maxQueryLength: number;
  maxResults: number;
  allowedFilterKeys: string[];
}

const intFromEnv = (name: string, value: string | undefined, min: number, max: number): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
};

/** Reads and validates handler settings from the environment once per cold start. */
export function settingsFromEnv(env: NodeJS.ProcessEnv): QuerySettings {
  return {
    maxQueryLength: intFromEnv('MAX_QUERY_LENGTH', env.MAX_QUERY_LENGTH, 1, 8000),
    maxResults: intFromEnv('MAX_RESULTS', env.MAX_RESULTS, 1, 100),
    allowedFilterKeys: (env.ALLOWED_FILTER_KEYS ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
  };
}

const filterValue = z.union([z.string().max(256), z.array(z.string().max(256)).min(1).max(10)]);

/**
 * Request schema. Mirrors the API Gateway model so the Lambda is safe even if
 * invoked another way (defence in depth).
 */
export function requestSchema(s: QuerySettings) {
  const allowed = new Set(s.allowedFilterKeys);
  const filter =
    s.allowedFilterKeys.length > 0
      ? z
          .record(z.string(), filterValue)
          .refine((f) => Object.keys(f).length > 0, 'filter must not be empty')
          .refine((f) => Object.keys(f).every((k) => allowed.has(k)), 'filter uses a key that is not allowed')
          .optional()
      : z.undefined({ error: 'filtering is not enabled' });

  return z
    .object({
      query: z.string().trim().min(1).max(s.maxQueryLength),
      maxResults: z.number().int().min(1).max(s.maxResults).optional(),
      filter,
    })
    .strict();
}

export type QueryRequest = z.infer<ReturnType<typeof requestSchema>>;

/** Converts `{ key: "v" | ["a","b"] }` into a Bedrock retrieval filter. */
export function toRetrievalFilter(filter: Record<string, string | string[]> | undefined): RetrievalFilter | undefined {
  if (!filter) return undefined;
  const clauses: RetrievalFilter[] = Object.entries(filter).map(([key, value]) =>
    Array.isArray(value) ? { in: { key, value } } : { equals: { key, value } },
  );
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : { andAll: clauses };
}
