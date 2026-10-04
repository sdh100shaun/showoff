import * as fs from 'fs';
import * as path from 'path';
import { compare, parseQuestions, score, summarise } from '../scripts/eval-lib';

describe('evaluation metrics', () => {
  const q = { id: 'q1', question: 'x', expectedSources: ['documents/b.pdf'] };

  test('the committed example question file is valid', () => {
    const qs = parseQuestions(fs.readFileSync(path.join(__dirname, '..', 'eval', 'questions.example.jsonl'), 'utf8'));
    expect(qs.length).toBeGreaterThan(0);
  });

  test('rank counts distinct documents, not chunks', () => {
    expect(score(q, ['documents/a.pdf', 'documents/a.pdf', 'documents/b.pdf'], 10).firstHitRank).toBe(2);
    expect(score(q, ['documents/a.pdf'], 10).firstHitRank).toBeNull();
  });

  test('summarise computes hit rate, MRR and latency percentiles', () => {
    const s = summarise(
      [
        { id: '1', retrieved: [], firstHitRank: 1, latencyMs: 100 },
        { id: '2', retrieved: [], firstHitRank: 2, latencyMs: 300 },
        { id: '3', retrieved: [], firstHitRank: null, latencyMs: 200 },
        { id: '4', retrieved: [], firstHitRank: 6, latencyMs: 400 },
      ],
      5,
    );
    expect(s).toEqual({ questions: 4, k: 5, hitRate: 0.5, mrr: 0.417, latencyP50Ms: 200, latencyP95Ms: 400, errors: 0 });
  });

  test('compare reports deltas against a baseline', () => {
    const base = { questions: 4, k: 5, hitRate: 0.5, mrr: 0.4, latencyP50Ms: 200, latencyP95Ms: 400, errors: 0 };
    expect(compare({ ...base, hitRate: 0.75 }, base).hitRate).toBe('0.75 (+0.250)');
  });

  test('rejects invalid and duplicate questions', () => {
    expect(() => parseQuestions('{"id":"a","question":"q","expectedSources":[]}')).toThrow(/expectedSources/);
    const line = JSON.stringify(q);
    expect(() => parseQuestions(`${line}\n${line}`)).toThrow(/Duplicate/);
  });
});
