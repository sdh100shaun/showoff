# Serverless knowledge base: S3, Bedrock Knowledge Bases and S3 Vectors

A serverless "gather context" retrieval service for AI agents and RAG apps,
built with AWS CDK in TypeScript.

- **Documents** go into an encrypted S3 bucket.
- **Amazon Bedrock Knowledge Bases** handles chunking, embedding and retrieval.
- **Amazon S3 Vectors** is the vector store: no cluster to size or patch.
- **Ingestion is automatic.** S3 change events go through EventBridge and SQS,
  which debounces them and starts a Bedrock ingestion job.
- **Retrieval is exposed through an authenticated API.** API Gateway uses the
  Cognito OAuth2 client-credentials grant, sits behind WAF, and calls a Lambda
  that runs `Retrieve` (and optionally `RetrieveAndGenerate`).

See [`docs/PLAN.md`](docs/PLAN.md) for the design and trade-offs, and
[`docs/REVIEW.md`](docs/REVIEW.md) for the developer and security-architecture
review.

```
Agent ──OAuth2 token──► Cognito
  │
  └─HTTPS──► WAF ─► API Gateway (scopes) ─► Lambda ─► Bedrock KB ─► S3 Vectors (KMS)
                                                         ▲
S3 documents (KMS) ─► EventBridge ─► SQS ─► Lambda ──────┘ StartIngestionJob
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
| `knowledgeBase.embeddingModelId` / `embeddingDimensions` | Titan v2 / 1024 | Changing either replaces the index |
| `knowledgeBase.chunking` | fixed 300 tokens, 20% overlap | `FIXED_SIZE`, `SEMANTIC` or `NONE` |
| `ingestion.batchWindowSeconds` | 60 | Debounce for bursts of uploads |
| `ingestion.scheduleExpression` | none | Safety-net full sync, for example `rate(1 day)` |
| `api.clients` | one `retrieve` client | One Cognito app client per agent or service |
| `api.allowedFilterKeys` | `[]` | Metadata keys callers may filter on |
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

**1. Add documents.** Upload them under the configured prefix. Ingestion
starts automatically after the batch window. Optional
[metadata files](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-metadata.html)
(`<doc>.metadata.json`) enable filtering.

```bash
aws s3 cp ./handbook.pdf "s3://$BUCKET/documents/handbook.pdf"   # BUCKET from the stack output
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
TOKEN=$(curl -s -u "$CLIENT_ID:$CLIENT_SECRET" -d 'grant_type=client_credentials&scope=kb-api/retrieve' \
  "$TOKEN_ENDPOINT" | jq -r .access_token)
```

**3. Retrieve context.**

```bash
curl -s "$API_URL/retrieve" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"What is the travel expenses policy?","maxResults":5,"filter":{"department":"finance"}}'
```

```json
{
  "references": [
    { "text": "…", "score": 0.82, "source": { "key": "documents/handbook.pdf" }, "chunkId": "…", "metadata": { "department": "finance" } }
  ]
}
```

Filter values can be a string (equals) or an array (in). Several keys are
combined with AND. Only keys listed in `api.allowedFilterKeys` are accepted.

**4. (Optional) Ask.** With `generation.enabled`, `POST /ask` takes the same
body and needs the `kb-api/ask` scope. It returns
`{ answer, guardrailAction, references }`. The prompt tells the model to treat
retrieved text as untrusted data. For stronger protection, configure a Bedrock
Guardrail (`generation.guardrailId` and `guardrailVersion`).

## Operations

- **Alarms** go to an encrypted SNS topic (set `observability.alarmEmail`).
  They cover API 5xx errors, Lambda errors, query throttling and messages in
  the ingestion dead-letter queue.
- **Failed ingestion triggers** end up in the DLQ after `maxReceiveCount`
  attempts. Investigate, then redrive from the SQS console. Also check the
  ingestion job history in the Bedrock console for per-document failures.
- **Manual sync:** `aws bedrock-agent start-ingestion-job --knowledge-base-id … --data-source-id …`
- **Rotating a client secret:** add a new client in config, deploy, move the
  caller over, then remove the old client.

## Limits and upgrade path

- S3 Vectors query latency is around **hundreds of milliseconds**. That's fine
  for a once-per-request context step, but not for tight agent loops.
- There is no hybrid (BM25 plus vector) search. If you need it later,
  OpenSearch can use S3 Vectors as its engine, so you won't have to migrate
  data.
- Knowledge graph memory (Graphiti/Cognee) is out of scope for this pilot.
  Phase it in only if plain vector retrieval turns out not to be enough.

## Layout

```
bin/app.ts                 CDK entry point (config + cdk-nag)
lib/config.ts              zod schema and loader
lib/kb-stack.ts            stack wiring
lib/constructs/            encryption, document store, vector store, KB, ingestion, API, network, monitoring
lib/nag-suppressions.ts    every accepted cdk-nag finding with its justification
src/handlers/              Lambda handlers (query, ingest)
test/                      unit tests (handlers, config) and infrastructure assertions (both configurations)
scripts/check-secrets.sh   guards against committing account ids, keys or env configs
```
