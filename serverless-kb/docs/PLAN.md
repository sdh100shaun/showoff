# Plan: Serverless knowledge base on S3 + Bedrock Knowledge Bases (S3 Vectors)

## 1. Context and decision

This implements **Route 2** from the design discussion: skip a self-managed
document pipeline (Cognee) for the document side and use **Amazon Bedrock
Knowledge Bases** with **Amazon S3 Vectors** as the vector store. Bedrock
handles chunking, embedding and retrieval. Ingestion is managed rather than
something we run.

Why this route for a pilot:

- **Fully serverless.** No cluster to size or patch. This fits the DynamoDB and
  S3 direction of the wider estate.
- **Cost.** S3 Vectors is priced for storage-heavy, query-light workloads.
- **Assurance.** Encryption at rest with customer-managed KMS keys, TLS-only
  access, optional PrivateLink (VPC interface endpoints), and CloudTrail
  auditability throughout.
- **Phasing.** Prove value with managed retrieval first. Bring in a knowledge
  graph (Cognee or Graphiti) only if plain vector retrieval proves
  insufficient.

Accepted trade-offs (from the discussion):

- Query latency is in the **hundreds of milliseconds**. That suits a "gather
  context" step run once per request, but not tight agent loops making many
  retrievals.
- **Vector similarity plus metadata filtering only**, with no hybrid
  BM25+vector search. The upgrade path is OpenSearch using S3 Vectors as a
  low-cost engine, without migrating data.
- **Region availability must be confirmed.** The target is `eu-west-2`
  (London). Check the S3 Vectors and Bedrock KB regional availability pages
  before deploying. The region is configuration, never hard-coded.

## 1a. Alignment with the target architecture (from the full design chat)

This service is **one component** of the wider agent platform. It replaces
Cognee on the *document* side (Route 2). It is not the whole platform.

```
           ┌──────────────── Orchestrator (LangGraph, Fargate) ────────────────┐
request ──►│ gather-context node ──► trim to token budget ──► worker agents ──► │──► write-back episode
           └──────┬───────────────────────────────┬────────────────────────────┘        (Graphiti)
                  │ MCP / HTTPS + caller identity  │
           ┌──────▼──────── Gateway (built in-house) ──────────────────────────┐
           │ authN, map user/team → access groups (Aurora MySQL),               │
           │ scope every query, audit what context each agent saw               │
           └──────┬───────────────────────────────┬────────────────────────────┘
                  │                               │
        ┌─────────▼─────────┐            ┌────────▼─────────┐
        │ THIS SERVICE       │            │ Graphiti (phase 3)│
        │ documents: S3 →    │            │ memory: Neptune/  │
        │ Bedrock KB →       │            │ Neo4j             │
        │ S3 Vectors         │            └───────────────────┘
        └───────────────────┘
```

Where each store sits (no PostgreSQL anywhere):

| Store | Holds | Owner |
|---|---|---|
| S3 + S3 Vectors + Bedrock KB | Documents, chunks, embeddings | **This service** |
| DynamoDB | Ingestion job tracking and idempotency keys (TTL) | **This service** |
| DynamoDB (+ S3 offload, TTL) | LangGraph checkpoints (`langgraph-checkpoint-aws` DynamoDBSaver) | Orchestrator |
| Aurora MySQL | Permission model (users and teams → access groups / Graphiti group IDs), audit log of context served | Gateway (consumes this service's audit events) |
| Neptune (or Neo4j) | Graphiti temporal memory | Phase 3 |

What this service must provide so it fits that picture:

1. **Identity passthrough and scoping on every query.** Each document carries
   an `access_group` metadata attribute. Each API client is granted access
   groups as OAuth scopes (`kb-api/group:<name>`), which form a ceiling
   enforced by this service. The gateway passes the end user's identity
   (`X-On-Behalf-Of`) and may **narrow** the groups per request
   (`X-Access-Groups`), but can never widen them. Retrieval always applies a
   mandatory `access_group IN (...)` filter that the caller can't override.
   Documents without a group are never returned (deny by default). Group names
   map 1:1 to teams or classifications, matching Graphiti group IDs.
2. **An audit trail of what context each agent was given.** Every response
   emits a `ContextServed` event (caller, on-behalf-of, agent/run/trace ids,
   effective groups, query hash, and the source keys, chunk ids and scores
   returned, but no text) to an encrypted EventBridge bus with an archive. The
   gateway's Aurora MySQL audit tables (and Langfuse, via the trace id)
   consume it. Delivery fails closed: if the audit event can't be written, no
   context is returned.
3. **A curated briefing, not raw hits.** An optional `maxTokens` budget on each
   request trims results (highest score first) so the gather-context node can
   allocate its budget across sources.
4. **MCP as well as REST.** A stateless MCP (Streamable HTTP) endpoint at
   `/v1/mcp` exposes `search_documents` (and `ask_documents` when generation is
   on), with the same auth, scoping and audit. The orchestrator then talks to
   documents the same way it talks to Graphiti, which keeps components
   swappable.
5. **Idempotent ingestion tracking.** A DynamoDB table (TTL) records the event
   ids already handed to an ingestion job, and which job covered them. Retried
   or duplicated messages don't start redundant jobs, and every change is
   traceable to a job.
6. **An evaluation baseline.** `npm run eval` scores retrieval (hit@k, MRR,
   latency) against a git-ignored set of 30–50 questions with known source
   documents. This is the plain-RAG baseline that a later Cognee or Graphiti
   phase must beat.
7. **Data residency guard.** Generation models are restricted to an allowed
   inference geography (default `eu`, so `global.` or `us.` profiles are
   rejected at synth), because London versus EU cross-region inference matters
   for data assurance. Embeddings always run in-region.

Phasing, mapped to the design chat:

| Phase | Chat | Here |
|---|---|---|
| 1 | Start with one well-understood corpus | One KB, one data source; retrieve-only by default |
| 2 | 30–50 question evaluation set vs plain RAG | `eval/` harness and baseline results |
| 3 | Add Graphiti only when memory across runs is needed | Out of scope (separate service; same gateway/MCP pattern) |
| 4 | Gateway permission model **before** sensitive data | Group scoping, the identity passthrough contract and audit events are built in now. The gateway's MySQL model consumes them. |

Cost note from the chat: graph extraction is the hidden cost for Cognee and
Graphiti. On this route the per-document cost is **embeddings only**, and
Bedrock sync is incremental: only changed documents are re-embedded.

## 2. Architecture

```
                      ┌──────────────────────────── AWS account (target region) ───────────────────────────┐
                      │                                                                                     │
 Agent / client ──TLS─┼─► WAF (rate limit, managed rules) ─► API Gateway (REST, regional)                    │
  (OAuth2 client      │                                         │  Cognito authorizer (client-credentials,  │
   credentials)       │                                         │  scope-checked per route)                 │
                      │                                         ▼                                           │
                      │                               Lambda: query (Node 22, TS)                           │
                      │                                 POST /retrieve  → bedrock-agent-runtime:Retrieve    │
                      │                                 POST /ask       → RetrieveAndGenerate (optional)    │
                      │                                         │                                           │
                      │                                         ▼                                           │
                      │   S3 source bucket ──data source──► Bedrock Knowledge Base ──► S3 Vectors           │
                      │   (KMS CMK, versioned,               (Titan Embed v2,          vector bucket + index│
                      │    TLS-only, BPA)                     configurable)            (KMS CMK)            │
                      │        │                                    ▲                                       │
                      │        │ EventBridge (Object Created/Deleted)│ StartIngestionJob                    │
                      │        ▼                                    │                                       │
                      │   SQS (KMS, DLQ, batching window) ─► Lambda: ingest-trigger                         │
                      │                                                                                     │
                      │   Optional: VPC (isolated subnets) + interface endpoints (PrivateLink) for Lambdas   │
                      └─────────────────────────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Purpose | Key security controls |
|---|---|---|
| KMS CMK (one per stack) | Encrypts source docs, vectors, queues and logs | Key rotation, least-privilege key policy, service-principal grants scoped by `aws:SourceAccount` |
| S3 source bucket | Documents to index (prefix configurable) | Block Public Access, `enforceSSL`, SSE-KMS, versioning, server access logs, lifecycle for noncurrent versions |
| S3 access-log bucket | Server access logs for the source bucket | SSE-S3 (required for log delivery), BPA, TLS-only, expiry |
| S3 Vectors bucket + index | Vector store (`AWS::S3Vectors::*`) | SSE-KMS with the CMK; `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA` are non-filterable |
| Bedrock Knowledge Base | Chunking, embedding, retrieval | Dedicated service role scoped to exactly this bucket/prefix, index and model |
| Bedrock data source | Points at the S3 prefix | Configurable chunking strategy; `dataDeletionPolicy` configurable |
| EventBridge rule → SQS → ingest Lambda | Re-ingest when docs change, debounced | Queue SSE-KMS, DLQ, `ConflictException` handled by retry (one ingestion job at a time) |
| Scheduled rule (optional) | Periodic full sync as a safety net | — |
| API Gateway REST | Public entry point | Cognito authorizer with OAuth scopes, request validation (JSON schema), throttling, access logs, X-Ray, TLS 1.2 |
| Cognito User Pool + resource server | Machine-to-machine auth for agents | Client-credentials only, no self sign-up, no hosted UI user flows, advanced security where available |
| WAFv2 Web ACL | Edge protection | AWS managed common/bad-inputs rules, IP reputation, rate-based rule |
| Query Lambda | Validates input, calls Retrieve/RetrieveAndGenerate | zod validation, size caps, metadata filter allow-list, no query text in logs by default, least-privilege IAM |
| CloudWatch | Logs, metrics, alarms | KMS-encrypted log groups, retention set, alarms for 5xx, DLQ depth, ingestion failures |

### API contract (v1)

`POST /v1/retrieve` (scope `<resourceServer>/retrieve`)

```json
{ "query": "string (1..N chars)", "maxResults": 5, "filter": { "equals": { "key": "department", "value": "finance" } } }
```

The response returns chunks with text, score and source location. S3 URIs are
reduced to object keys so bucket names never leak to callers.

`POST /v1/ask` (scope `<resourceServer>/ask`, deployed only when
`generation.enabled = true`) returns a generated answer plus citations, using a
configurable model or inference profile.

## 3. Configuration strategy (public repository)

The repository is public, so **no environment-specific values are committed**.

- `config/config.example.json` is a committed, documented template with
  placeholder values only.
- `config/<env>.json` (for example `config/dev.json`) holds real values and is
  **git-ignored**.
- The environment is chosen with `-c env=<name>` or `KB_ENV`. Individual values
  can be overridden by `KB_*` environment variables, which suits CI with
  OIDC-provided secrets.
- All config is validated at synth time with **zod**. Synthesis fails fast with
  a clear message. Region and account come from the CDK environment
  (`CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION` or the config), never from
  literals in code.
- `cdk.context.json`, `cdk.out/`, `.env*`, and `config/*.json` (except the
  example) are git-ignored. A pre-commit-style `npm run check:secrets` script
  greps for account IDs, ARNs and access keys in tracked files.
- No secrets are needed at runtime. Lambdas receive only resource identifiers
  (KB ID, model ARN) via environment variables, encrypted with the CMK.

## 4. Security design notes

- **Least privilege.** Each role gets only the actions it needs on specific
  ARNs: the KB role, the ingest Lambda (`bedrock:StartIngestionJob` on the one
  KB) and the query Lambda (`bedrock:Retrieve` and optional
  `bedrock:RetrieveAndGenerate` plus `bedrock:InvokeModel` on the one model).
- **Confused deputy.** Bedrock and S3 Vectors trust policies and KMS grants use
  `aws:SourceAccount`/`aws:SourceArn` conditions.
- **Data in transit.** TLS only. S3 bucket policies deny `aws:SecureTransport =
  false`. API Gateway enforces a TLS 1.2 minimum.
- **Data at rest.** A single CMK with rotation covers S3, S3 Vectors, SQS, the
  CloudWatch Logs groups and Lambda environment variables.
- **Network.** Public API with WAF by default. Optionally (`network.enableVpc`),
  Lambdas run in isolated subnets with interface endpoints for
  `bedrock-agent-runtime`, `bedrock-agent`, `bedrock-runtime`, `logs`, `sqs`
  and `kms` (PrivateLink, no NAT).
- **Input handling.** Strict schema validation (API Gateway model plus zod in
  Lambda), maximum query length, maximum results cap, and a filter-key
  allow-list to prevent probing arbitrary metadata.
- **Prompt injection (ask route).** Indexed documents are untrusted content. A
  system prompt template instructs the model to treat retrieved text as data,
  and Bedrock Guardrails are optional via config (`generation.guardrailId`).
  Retrieve-only is the default.
- **Logging hygiene.** Query text and results are not logged unless
  `observability.logQueries` is explicitly enabled (for example in dev).
- **Static analysis.** `cdk-nag` (AwsSolutions pack) runs on every synth.
  Suppressions are explicit and justified in code.
- **Teardown.** The removal policy is configurable: `RETAIN` for prod,
  `DESTROY` for dev.

## 5. Repository layout

```
serverless-kb/
├── bin/app.ts                    # CDK entry; loads config, applies cdk-nag
├── lib/
│   ├── config.ts                 # zod schema + loader (file + env overrides)
│   ├── kb-stack.ts               # top-level stack wiring constructs
│   └── constructs/
│       ├── encryption.ts         # CMK + key policy
│       ├── document-store.ts     # source + access-log buckets
│       ├── vector-store.ts       # S3 Vectors bucket + index
│       ├── knowledge-base.ts     # Bedrock KB, data source, service role
│       ├── ingestion.ts          # EventBridge → SQS → Lambda, schedule
│       ├── query-api.ts          # API GW, Cognito, WAF, query Lambda
│       ├── network.ts            # optional VPC + endpoints
│       └── monitoring.ts         # alarms
├── src/
│   ├── handlers/ingest.ts
│   ├── handlers/query.ts
│   └── shared/{validation,http,logger}.ts
├── test/                         # jest: handler unit tests + CDK assertions + nag
├── config/config.example.json
├── scripts/check-secrets.sh
└── docs/{PLAN.md,REVIEW.md}
```

## 6. Delivery steps

1. Commit this plan.
2. Scaffold the TypeScript CDK project (strict TS, eslint, jest, esbuild via
   `NodejsFunction`).
3. Add the config loader and schema, the example config and the `.gitignore`
   rules.
4. Build the constructs: encryption, document store, vector store, knowledge
   base, ingestion, query API, network, monitoring.
5. Write the Lambda handlers with validation and error mapping.
6. Write tests: handler unit tests (mocked SDK), CDK assertion tests and a
   cdk-nag clean synth.
7. Run `npm run build`, `lint`, `test`, `cdk synth` and `check:secrets`.
8. Write a README covering deployment, configuration, operations and the
   upgrade path.
9. Run the review as a **developer** and as a **security architect**, write the
   findings to `docs/REVIEW.md`, and fix what is in scope.
10. Commit and push.
11. **Alignment pass** (section 1a): access-group scoping, audit events, the
    token budget, MCP endpoint, DynamoDB ingestion tracking, the eval harness
    and the residency guard, with tests, documentation and a re-review.

## 7. Out of scope for the pilot (future phases)

- Knowledge graph memory (Graphiti, phase 3) and Cognee's graph extraction.
- Hybrid search (OpenSearch Serverless with an S3 Vectors engine).
- The gateway itself, with its Aurora MySQL permission model and audit tables
  (this service provides the enforcement point and the audit event stream).
- The orchestrator (LangGraph on Fargate, DynamoDBSaver checkpoints) and
  Langfuse tracing.
- A custom domain and certificate for the API. Optional config is stubbed only.
- Multi-region DR.
