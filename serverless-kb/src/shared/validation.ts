import type { RetrievalFilter } from '@aws-sdk/client-bedrock-agent-runtime';
import { z } from 'zod';
import type { Settings } from '../core/settings';

const filterValue = z.union([z.string().max(256), z.array(z.string().max(256)).min(1).max(10)]);

/**
 * Request schema. Mirrors the API Gateway model so the Lambda is safe even if
 * invoked another way (defence in depth), and validates MCP tool arguments.
 */
export function requestSchema(s: Pick<Settings, 'maxQueryLength' | 'maxResults' | 'maxTokenBudget' | 'allowedFilterKeys'>) {
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
      /** Context budget: results are trimmed (highest score first) to fit. */
      maxTokens: z.number().int().min(1).max(s.maxTokenBudget).optional(),
      filter,
    })
    .strict();
}

export type QueryRequest = z.infer<ReturnType<typeof requestSchema>>;

/** Issues as "path: message", never echoing input values. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
}

/**
 * Builds the Bedrock filter: the mandatory access-group clause (if any) AND the
 * caller's own filters. The access clause cannot be overridden because the
 * access key is never an allowed caller filter key (enforced in config).
 */
export function buildFilter(
  access: { metadataKey: string; groups: string[] } | undefined,
  filter: Record<string, string | string[]> | undefined,
): RetrievalFilter | undefined {
  const clauses: RetrievalFilter[] = [];
  if (access) clauses.push({ in: { key: access.metadataKey, value: access.groups } });
  for (const [key, value] of Object.entries(filter ?? {})) {
    clauses.push(Array.isArray(value) ? { in: { key, value } } : { equals: { key, value } });
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : { andAll: clauses };
}
