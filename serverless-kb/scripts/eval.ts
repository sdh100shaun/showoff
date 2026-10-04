/* eslint-disable no-console */
/**
 * Retrieval evaluation runner.
 *
 *   npm run eval -- --questions eval/questions.jsonl [--k 5] [--mode api|direct] [--baseline eval/results/<file>.json]
 *
 * api mode (default) goes through the deployed API exactly as an agent would
 * (OAuth2 client credentials, access-group scoping, audit):
 *   KB_API_URL, KB_TOKEN_ENDPOINT, KB_CLIENT_ID, KB_CLIENT_SECRET
 * direct mode calls Bedrock Retrieve with your AWS credentials:
 *   KB_ID [, KB_ACCESS_KEY=access_group]
 *
 * Credentials come from the environment only and are never written to disk.
 * Question files and results are git-ignored: they describe your corpus.
 */
import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import * as fs from 'fs';
import * as path from 'path';
import { compare, parseQuestions, Question, QuestionResult, score, summarise, Summary } from './eval-lib';

interface Args {
  questions: string;
  k: number;
  mode: 'api' | 'direct';
  baseline?: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = get('mode') ?? 'api';
  if (mode !== 'api' && mode !== 'direct') throw new Error('--mode must be api or direct');
  const k = Number(get('k') ?? 5);
  if (!Number.isInteger(k) || k < 1 || k > 100) throw new Error('--k must be 1..100');
  return { questions: get('questions') ?? 'eval/questions.jsonl', k, mode, baseline: get('baseline'), out: get('out') ?? 'eval/results' };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

async function apiRetriever(k: number): Promise<(q: Question) => Promise<string[]>> {
  const tokenRes = await fetch(env('KB_TOKEN_ENDPOINT'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${env('KB_CLIENT_ID')}:${env('KB_CLIENT_SECRET')}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!tokenRes.ok) throw new Error(`Token request failed: HTTP ${tokenRes.status}`);
  const { access_token: token } = (await tokenRes.json()) as { access_token: string };
  const url = `${env('KB_API_URL').replace(/\/$/, '')}/retrieve`;

  return async (q) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Agent-Id': 'eval-runner',
        'X-Run-Id': `eval-${q.id}`,
        ...(q.accessGroups ? { 'X-Access-Groups': q.accessGroups.join(',') } : {}),
      },
      body: JSON.stringify({ query: q.question, maxResults: k }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { references: { source?: { key: string } }[] };
    return body.references.map((r) => r.source?.key ?? '');
  };
}

function directRetriever(k: number): (q: Question) => Promise<string[]> {
  const client = new BedrockAgentRuntimeClient({});
  const knowledgeBaseId = env('KB_ID');
  const accessKey = process.env.KB_ACCESS_KEY ?? 'access_group';
  return async (q) => {
    const res = await client.send(
      new RetrieveCommand({
        knowledgeBaseId,
        retrievalQuery: { text: q.question },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: k,
            ...(q.accessGroups ? { filter: { in: { key: accessKey, value: q.accessGroups } } } : {}),
          },
        },
      }),
    );
    return (res.retrievalResults ?? []).map((r) => /^s3:\/\/[^/]+\/(.+)$/.exec(r.location?.s3Location?.uri ?? '')?.[1] ?? '');
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const questions = parseQuestions(fs.readFileSync(args.questions, 'utf8'));
  if (questions.length < 30) console.warn(`Note: ${questions.length} questions; 30–50 are recommended for a meaningful baseline.`);

  const retrieve = args.mode === 'api' ? await apiRetriever(args.k) : directRetriever(args.k);
  const results: QuestionResult[] = [];
  for (const q of questions) {
    const started = Date.now();
    try {
      results.push(score(q, await retrieve(q), Date.now() - started));
    } catch (e) {
      results.push({ id: q.id, retrieved: [], firstHitRank: null, latencyMs: Date.now() - started, error: (e as Error).message });
    }
  }

  const summary = summarise(results, args.k);
  fs.mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.mode}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary, mode: args.mode, results }, null, 2));

  console.table(summary);
  if (args.baseline) {
    const baseline = (JSON.parse(fs.readFileSync(args.baseline, 'utf8')) as { summary: Summary }).summary;
    console.log('Versus baseline:');
    console.table(compare(summary, baseline));
  }
  const misses = results.filter((r) => r.firstHitRank === null).map((r) => r.id + (r.error ? ` (${r.error})` : ''));
  if (misses.length) console.log(`Missed: ${misses.join(', ')}`);
  console.log(`Results written to ${file}`);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
