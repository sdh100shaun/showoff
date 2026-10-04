import { z } from 'zod';

/**
 * Retrieval evaluation (phase 2 of the rollout): a fixed set of 30–50
 * questions with known source documents, scored on every change. The first
 * run is the plain-RAG baseline that later phases (Cognee graph, Graphiti
 * memory) must beat.
 */
export const questionSchema = z
  .object({
    id: z.string().regex(/^[\w.-]{1,64}$/),
    question: z.string().min(1).max(8000),
    /** Document keys (as returned in `source.key`) that answer the question. */
    expectedSources: z.array(z.string().min(1)).min(1),
    /** Optional: evaluate as a caller limited to these access groups. */
    accessGroups: z.array(z.string()).optional(),
  })
  .strict();

export type Question = z.infer<typeof questionSchema>;

export interface QuestionResult {
  id: string;
  retrieved: string[];
  /** 1-based rank of the first expected source, or null when missed. */
  firstHitRank: number | null;
  latencyMs: number;
  error?: string;
}

export interface Summary {
  questions: number;
  k: number;
  hitRate: number;
  mrr: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  errors: number;
}

export function parseQuestions(jsonl: string): Question[] {
  const questions = jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l, i) => {
      const parsed = questionSchema.safeParse(JSON.parse(l));
      if (!parsed.success) throw new Error(`Question line ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      return parsed.data;
    });
  const ids = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) throw new Error(`Duplicate question id ${q.id}`);
    ids.add(q.id);
  }
  return questions;
}

export function score(q: Question, retrieved: string[], latencyMs: number): QuestionResult {
  // Several chunks can come from one document: rank by distinct documents.
  const distinct = [...new Set(retrieved)];
  const idx = distinct.findIndex((key) => q.expectedSources.includes(key));
  return { id: q.id, retrieved: distinct, firstHitRank: idx === -1 ? null : idx + 1, latencyMs };
}

export function summarise(results: QuestionResult[], k: number): Summary {
  const ok = results.filter((r) => !r.error);
  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const n = results.length || 1;
  return {
    questions: results.length,
    k,
    hitRate: round(results.filter((r) => r.firstHitRank !== null && r.firstHitRank <= k).length / n),
    mrr: round(results.reduce((sum, r) => sum + (r.firstHitRank ? 1 / r.firstHitRank : 0), 0) / n),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    errors: results.length - ok.length,
  };
}

/** Per-metric change versus a baseline summary (positive = better, except latency). */
export function compare(current: Summary, baseline: Summary): Record<string, string> {
  const delta = (a: number, b: number, digits = 3) => `${a >= b ? '+' : ''}${(a - b).toFixed(digits)}`;
  return {
    hitRate: `${current.hitRate} (${delta(current.hitRate, baseline.hitRate)})`,
    mrr: `${current.mrr} (${delta(current.mrr, baseline.mrr)})`,
    latencyP50Ms: `${current.latencyP50Ms} (${delta(current.latencyP50Ms, baseline.latencyP50Ms, 0)})`,
    latencyP95Ms: `${current.latencyP95Ms} (${delta(current.latencyP95Ms, baseline.latencyP95Ms, 0)})`,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
