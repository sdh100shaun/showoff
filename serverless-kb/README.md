# Serverless knowledge base: S3, Bedrock Knowledge Bases and S3 Vectors

The **document side** of the agent platform: a serverless "gather context"
service that the orchestrator calls, through the gateway, before any worker
agent runs. It replaces Cognee for documents (Route 2 in the design) and is
built with AWS CDK in TypeScript.

- **Documents** go into an encrypted S3 bucket.
- **Amazon Bedrock Knowledge Bases** handles chunking, embedding and retrieval.
- **Amazon S3 Vectors** is the vector store: no cluster to size or patch.
- **Ingestion is automatic.** S3 change events go through EventBridge and SQS,
  which debounces them and starts a Bedrock ingestion job.
- **Retrieval is exposed as REST and MCP.** API Gateway uses the Cognito
  OAuth2 client-credentials grant, sits behind WAF, and calls a Lambda that
  runs `Retrieve` (and optionally `RetrieveAndGenerate`). The MCP endpoint
  lets the orchestrator treat documents like Graphiti's MCP server.
- **Every query is scoped.** Documents carry an `access_group`, and tokens
  carry the groups a client may read. The gateway passes the end user through
  and narrows per request. Retrieval is always filtered to those groups.
- **Every response is audited.** A `ContextServed` event records which agent,
  on whose behalf, received which document chunks. It goes to an encrypted,
  archived EventBridge bus for the gateway's Aurora MySQL audit store.
- **A token budget** trims results before they reach worker agents.
- **Ingestion tracking** lives in DynamoDB: idempotency keys and a record of
  which job covered which change.
- **`npm run eval`** scores retrieval against your 30–50 question set. That
  run is the baseline that later phases must beat.

See [`docs/PLAN.md`](docs/PLAN.md) for the design and trade-offs, and
[`docs/REVIEW.md`](docs/REVIEW.md) for the developer and security-architecture
review.

```
Orchestrator ─► Gateway ──OAuth2 token──► Cognito
 (gather-context   │  (user → groups in Aurora MySQL)
  node)            └─HTTPS/MCP + X-On-Behalf-Of, X-Access-Groups
                        │
                        ▼
                WAF ─► API Gateway (scopes) ─► Lambda ─► Bedrock KB ─► S3 Vectors (KMS)
                                                 │  ▲
                                 ContextServed ◄─┘  │ always: access_group IN (caller's groups)
                                 EventBridge bus ─► archive ─► gateway audit store (MySQL)

S3 documents (KMS) ─► EventBridge ─► SQS ─► Lambda ─► StartIngestionJob
                                              └─► DynamoDB (idempotency keys, job tracking, TTL)
```

## Before you start

1. **Check region support.** Confirm that S3 Vectors and Bedrock Knowledge
   Bases are both available in your target region (for example `eu-west-2`).
2. **Bedrock model access.** Embedding models are generally enabled by default
   now, but check that the embedding model (default
   `amazon.titan-embed-text-v2:0`) and any generation model are usable in your
   account and region.
3. **Tooling.** You need Node.js 22 or later, and AWS credentials for the
   target account.
4. **Bootstrap CDK** once per account and region: `npx cdk bootstrap`.

## Configure

The repository is public, so **real configuration is never committed**.

```bash
npm ci
cp config/config.example.json config/dev.json   # config/*.json is git-ignored
# edit config/dev.json: at minimum set api.cognitoDomainPrefix to something unique
```

Configuration is validated with zod at synth time. Invalid values fail fast
with the offending path.

| Source | Purpose |
|---|---|
| `config/<env>.json` | Your environment's settings (git-ignored) |
| `-c env=<env>` / `KB_ENV` | Selects the file |
| `KB_CONFIG_FILE` | Explicit path to a config file (for example a CI secret file) |
| `KB_ACCOUNT`, `KB_REGION` | Override target account/region |
| `KB_ALARM_EMAIL`, `KB_COGNITO_DOMAIN_PREFIX` | Override values you may not want in a file |
| `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` | Fallback from your AWS credentials |

Key settings (see `lib/config.ts` for all of them, with documentation):

| Setting | Default | Notes |
|---|---|---|
| `removalPolicy` | `retain` | Use `destroy` only for disposable environments |
| `documents.prefix` | `documents/` | Only objects under this prefix are indexed |
| `documents.writerPrincipalArns` | `[]` | Recommended: only these roles may write or delete documents |
| `knowledgeBase.embeddingModelId` / `embeddingDimensions` | Titan v2 / 1024 | Changing either replaces the index |
| `knowledgeBase.chunking` | fixed 300 tokens, 20% overlap | `FIXED_SIZE`, `SEMANTIC` or `NONE` |
| `ingestion.batchWindowSeconds` | 60 | Debounce for bursts of uploads |
| `ingestion.scheduleExpression` | none | Safety-net full sync, for example `rate(1 day)` |
| `api.clients` | one `retrieve` client | One Cognito app client per agent or service |
| `api.allowedFilterKeys` | `[]` | Metadata keys callers may filter on |
| `access.mode` / `access.groups` | `groups` / — | Mandatory document scoping; `open` only for a single trust domain |
| `api.clients[].accessGroups` / `delegating` | — / `false` | Group ceiling per client; `delegating` for the gateway |
| `api.maxTokenBudget` | 4000 | Upper bound for per-request `maxTokens` |
| `api.mcpEnabled` | `true` | MCP endpoint at `/v1/mcp` |
| `audit.enabled` / `failClosed` / `archiveRetentionDays` | `true` / `true` / 400 | ContextServed audit events |
| `ingestion.trackingTtlDays` | 30 | DynamoDB idempotency and job records |
| `generation.allowedInferenceGeographies` | `["eu"]` | Data-residency guard for inference profiles |
| `api.waf.enabled` | `true` | Managed rules plus a per-IP rate limit |
| `api.executionLogging` | `false` | Changes the account-wide API Gateway logging role |
| `generation.enabled` | `false` | Adds `POST /ask` (RetrieveAndGenerate) |
| `network.enableVpc` | `false` | Lambdas in isolated subnets, Bedrock reached via PrivateLink |
| `observability.logQueries` | `false` | Leave off outside dev, because queries may contain personal data |

## Build, test, deploy

```bash
npm run verify                          # typecheck, lint, unit + infrastructure tests, secret scan
npx cdk synth  -c env=dev               # cdk-nag (AwsSolutions) runs on every synth
npx cdk deploy -c env=dev
```

Synthesis fails on any cdk-nag finding that has not been acknowledged.
Acknowledgements live in one place, [`lib/nag-suppressions.ts`](lib/nag-suppressions.ts),
and each one carries a justification.

## Use

**1. Add documents with their access group.** Upload each document under the
configured prefix together with a
[metadata file](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-metadata.html).
With `access.mode: "groups"` (the default), **a document without
`access_group` is never returned to anyone**. Each document has exactly one
group. Groups map to teams or classifications, and use the same names as
Graphiti group IDs. Ingestion starts automatically after the batch window.

```bash
cat > handbook.pdf.metadata.json <<'JSON'
{ "metadataAttributes": { "access_group": "general", "department": "hr" } }
JSON
aws s3 cp ./handbook.pdf               "s3://$BUCKET/documents/handbook.pdf"   # BUCKET from the stack output
aws s3 cp ./handbook.pdf.metadata.json "s3://$BUCKET/documents/handbook.pdf.metadata.json"
```

Don't send encryption headers. The bucket default (the stack CMK) applies, and
requests that ask for a different key are denied.

**2. Get a token.** Read the client secret from Cognito. It is never output or
stored in this repository:

```bash
aws cognito-idp describe-user-pool-client --user-pool-id "$USER_POOL_ID" --client-id "$CLIENT_ID" \
  --query 'UserPoolClient.ClientSecret' --output text
```

```bash
TOKEN=$(curl -s -u "$CLIENT_ID:$CLIENT_SECRET" -d 'grant_type=client_credentials' \
  "$TOKEN_ENDPOINT" | jq -r .access_token)   # all scopes the client is allowed, including group:<name>
```

The token's `kb-api/group:<name>` scopes are the **ceiling** of what that
client can read. They come from `api.clients[].accessGroups`.

**3. Retrieve context.** This example shows the gateway calling on behalf of
a user:

```bash
curl -s "$API_URL/retrieve" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'X-On-Behalf-Of: user-123' -H 'X-Access-Groups: general,finance' \
  -H 'X-Agent-Id: planner' -H 'X-Run-Id: run-42' -H 'X-Trace-Id: <langfuse-trace-id>' \
  -d '{"query":"What is the travel expenses policy?","maxResults":5,"maxTokens":1500,"filter":{"department":"finance"}}'
```

```json
{
  "references": [
    { "text": "…", "score": 0.82, "source": { "key": "documents/handbook.pdf" }, "chunkId": "…", "metadata": { "access_group": "finance", "department": "finance" } }
  ],
  "usage": { "estimatedTokens": 1210, "truncated": true }
}
```

- **Identity passthrough contract.**
  - `X-Access-Groups` can only **narrow** the token's groups, never widen them.
  - Clients marked `delegating` (the gateway) **must** send both
    `X-On-Behalf-Of` and `X-Access-Groups`. A forgotten header fails closed
    rather than exposing the gateway's full ceiling.
  - `X-Agent-Id`, `X-Run-Id` and `X-Trace-Id` are recorded for audit and
    Langfuse correlation.
- **Token budget.** `maxTokens` keeps whole chunks, highest score first, up to
  about that many tokens (estimated at 4 characters per token).
- **Filters.** A value can be a string (equals) or an array (in). Several keys
  are combined with AND, and always with the access-group restriction. Only
  keys in `api.allowedFilterKeys` are accepted, and the access key itself
  never is.

**4. MCP.** Point an MCP client (Streamable HTTP) at `$API_URL/mcp` with
`Authorization: Bearer $TOKEN` and the same identity headers.
- **Tools:** `search_documents`, plus `ask_documents` when generation is
  enabled. `tools/list` only shows the tools the token allows.
- **Same behaviour as REST:** results, scoping, budget and audit are
  identical.
- **Stateless:** the endpoint uses JSON responses, offers no SSE stream (`GET`
  returns 405), and refuses requests with a browser `Origin` header.

**5. (Optional) Ask.** With `generation.enabled`, `POST /ask` takes the same
body and needs the `kb-api/ask` scope. It returns
`{ answer, guardrailAction, references }`. The prompt tells the model to treat
retrieved text as untrusted data. For stronger protection, configure a Bedrock
Guardrail (`generation.guardrailId` and `guardrailVersion`).

## Audit trail (for the gateway's audit store)

Every successful retrieve or ask emits one event to the bus named in the
`AuditBusName` stack output. The event has `source: kb.retrieval` and
`detail-type: ContextServed`:

```json
{ "requestId": "…", "channel": "rest|mcp", "operation": "retrieve|ask", "clientId": "…", "delegated": true,
  "onBehalfOf": "user-123", "agentId": "planner", "runId": "run-42", "traceId": "…",
  "accessGroups": ["general", "finance"], "filterKeys": ["department"], "queryHash": "<sha256>", "queryLength": 37,
  "answerReturned": false, "references": [{ "sourceKey": "documents/handbook.pdf", "chunkId": "…", "score": 0.82 }],
  "servedAt": "2026-…Z" }
```

- **No text is stored.** Events hold identifiers only: no query text and no
  document text.
- **Events are archived** (default 400 days), so the gateway's Aurora MySQL
  consumer can be added later and replay history.
- **To consume them,** add an EventBridge rule on the bus that targets an SQS
  queue or a Lambda writing into the gateway's `context_audit` table.
- **It fails closed** (`audit.failClosed`): if the event can't be written, the
  caller gets 503 and no context.

## Evaluation (phase 2)

1. **Write the question set.** Put 30–50 questions with known answers in
   `eval/questions.jsonl`. The file is git-ignored; use
   `eval/questions.example.jsonl` as the format.
2. **Run the baseline**, then re-run on every change and compare:

```bash
export KB_API_URL=… KB_TOKEN_ENDPOINT=… KB_CLIENT_ID=… KB_CLIENT_SECRET=…   # the eval-runner client
npm run eval -- --questions eval/questions.jsonl --k 5                       # writes eval/results/<time>-api.json
npm run eval -- --questions eval/questions.jsonl --k 5 --baseline eval/results/<baseline>.json
# or bypass the API with your AWS credentials: KB_ID=… npm run eval -- --mode direct
```

The run reports hit rate@k, MRR and p50/p95 latency. Adding Cognee's graph or
Graphiti memory later is only worth it if this baseline is clearly beaten.

## Data residency

- **Embeddings** always run in the deployment region.
- **Generation models** (`/ask`) are checked at synth. When generation uses an
  inference profile, its geography must be in
  `generation.allowedInferenceGeographies`, which defaults to `["eu"]`. That
  means `global.*` or `us.*` profiles are rejected unless explicitly allowed.
- **Before choosing a model,** check which models are available in-region in
  London versus via EU cross-region inference.

## Operations

- **Alarms** go to an encrypted SNS topic (set `observability.alarmEmail`).
  They cover API 5xx errors, Lambda errors, query throttling and messages in
  the ingestion dead-letter queue.
- **Failed ingestion triggers** end up in the DLQ after `maxReceiveCount`
  attempts. Investigate, then redrive from the SQS console. Also check the
  ingestion job history in the Bedrock console for per-document failures.
- **Ingestion traceability:** the `TrackingTable` holds `event#<eventId>` →
  `ingestionJobId` and `job#<jobId>` → change count, with a TTL of
  `ingestion.trackingTtlDays`.
- **Cost:** on this route the per-document cost is embeddings only, and syncs
  are incremental. Watch Bedrock and S3 Vectors spend in Cost Explorer. Graph
  extraction costs only arrive with Cognee or Graphiti.
- **Manual sync:** `aws bedrock-agent start-ingestion-job --knowledge-base-id … --data-source-id …`
- **Rotating a client secret:** add a new client in config, deploy, move the
  caller over, then remove the old client.

## Limits and upgrade path

- S3 Vectors query latency is around **hundreds of milliseconds**. That's fine
  for a once-per-request context step, but not for tight agent loops.
- There is no hybrid (BM25 plus vector) search. If you need it later,
  OpenSearch can use S3 Vectors as its engine, so you won't have to migrate
  data.
- Knowledge graph memory (Graphiti) and Cognee's graph are later phases. Add
  them behind the same gateway and MCP pattern only if the evaluation shows
  plain vector retrieval isn't enough.
- One access group per document. Multi-group documents need either
  duplicating the document per group or a list-valued filter, once S3 Vectors
  supports one.

## Layout

```
bin/app.ts                 CDK entry point (config + cdk-nag)
lib/config.ts              zod schema and loader
lib/kb-stack.ts            stack wiring
lib/constructs/            encryption, document store, vector store, KB, ingestion (+ tracking table),
                           API (REST + MCP, Cognito, WAF), audit trail, network, monitoring
lib/nag-suppressions.ts    every accepted cdk-nag finding with its justification
src/handlers/              Lambda entry points (query, ingest)
src/core/                  access scoping, retrieval + token budget, audit, MCP, service
scripts/eval*.ts           retrieval evaluation harness
eval/                      example question set (real sets and results are git-ignored)
test/                      unit tests (handlers, config, eval) and infrastructure assertions (both configurations)
scripts/check-secrets.sh   guards against committing account ids, keys or env configs
```
