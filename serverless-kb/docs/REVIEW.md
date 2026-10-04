# Review: developer and security architecture

**Scope:** everything under `serverless-kb/`: CDK app, constructs, Lambda
handlers, configuration, tests and scripts.

**Method:**

- Line-by-line code read.
- Inspection of the **synthesized CloudFormation**: every IAM policy, KMS key
  policy and resource policy was dumped and read, not just the CDK source.
- cdk-nag (AwsSolutions) on both the default and the "everything enabled"
  configurations.
- Unit tests, infrastructure assertion tests and the secret scan.

**Limitation:** the stack has **not been deployed** to an AWS account in this
review. The items in the [pre-production checklist](#4-pre-production-checklist)
must be confirmed on the first real deployment.

**Overall:** suitable for a **pilot with a single trust domain**, meaning all
callers may see all indexed documents, once the checklist is complete. Before
onboarding multiple data owners or tenants, resolve finding **S-07**
(document-level authorization).

Severity: **High** means it breaks deployment or exposes data. **Medium** means
it weakens a control or causes operational failure. **Low** covers hygiene and
hardening.

---

## 1. Fixed during this review

| ID | Sev | Area | Finding | Resolution |
|---|---|---|---|---|
| D-01 | High | Dev | The knowledge base and data source had **fixed names**. Changing the embedding model, dimensions, metric, prefix or chunking forces replacement, and CloudFormation creates the new resource before deleting the old one, so the update would fail with a name conflict. | Names now carry a hash of the replacement-triggering settings (`kb-<hash>`, `documents-<hash>`). Covered by tests. |
| S-01 | Medium | Sec | **72 unset CDK feature flags** meant legacy behaviour. Notably, the EventBridge → encrypted SQS target granted `events.amazonaws.com` `SendMessage` *and* KMS use **with no account condition** (a confused-deputy gap). | Pinned all currently recommended flags in `cdk.json`. Queue and key grants are now conditioned on `aws:SourceAccount`. A test asserts that every service-principal statement in the key policy has a condition. |
| S-02 | Medium | Sec | The Cognito **OAuth2 token endpoint** is public but had no WAF, leaving client secrets open to unthrottled guessing. | The same Web ACL (IP reputation, managed rules, per-IP rate limit) is now associated with the user pool. |
| S-03 | Medium | Sec | **Document poisoning / indirect prompt injection.** Anyone in the account with `s3:PutObject` could plant content that agents then consume as trusted context. | Added `documents.writerPrincipalArns`, which denies writes, deletes and tagging by every other principal. It is opt-in so a pilot isn't locked out, and the README recommends it. The hardened prompt template and optional Guardrail cover the `/ask` path. Residual risk: see S-08. |
| S-04 | Low | Sec | The KMS key had a redundant unconditioned-style EventBridge statement. | Now a CloudWatch-alarms-only statement. EventBridge access comes from the (now conditioned) CDK grant. |
| D-02 | Low | Dev | `projectName`/`envName` allowed `--` and trailing hyphens, which Bedrock KB names reject at deploy time. | The regex now enforces single hyphens between words. Tested. |
| D-03 | Low | Dev | `package.json` declared a `bin` pointing at a file that doesn't exist. | Removed. |

---

## 2. Developer review

### What is good

- **Typed, validated config.** The zod schema fails synth with precise paths.
  There are no literals for account, region, ARNs or emails in code. Env
  overrides exist for CI.
- **Small, single-purpose constructs** with clear seams (`Encryption`,
  `DocumentStore`, `VectorStore`, `KnowledgeBase`, `Ingestion`, `QueryApi`,
  `Network`, `Monitoring`). Hardened Lambda defaults are centralized in
  `SecureFunction`.
- **Input validation happens twice:** the API Gateway JSON-schema model, then
  zod in the Lambda. The same limits come from one config source.
- **Ingestion is correct under Bedrock's one-job-per-data-source rule.**
  Changes are debounced in SQS. On `ConflictException` the handler checks
  whether the running job started after the newest change (with a 5 s clock
  margin) before acknowledging, otherwise it retries through the visibility
  timeout. This logic is unit-tested.
- **Error mapping** gives 400, 429 or 500 without leaking internals. ARNs and
  bucket names never reach callers; S3 URIs are reduced to object keys.
- **Tests (66)** cover handlers with a mocked SDK, config, and infrastructure
  assertions in two configurations. cdk-nag is enforced in tests as well as at
  synth.

### Open items

| ID | Sev | Finding | Recommendation |
|---|---|---|---|
| D-04 | Medium | **No deployed integration test.** Correct behaviour against real Bedrock and S3 Vectors (CMK permissions, ingestion, filters) is unproven. | Add a post-deploy smoke test: upload a fixture with metadata, wait for the ingestion job, call `/retrieve` with and without a filter, and assert results. Run it in CI against a dev account (OIDC role). |
| D-05 | Medium | **Retry horizon for busy ingestion.** By default messages retry for about 60 min (`retryDelaySeconds` × `maxReceiveCount`). A longer full sync pushes later changes to the DLQ (which is alarmed). | Size these settings to the corpus. For large corpora, replace the SQS retry with a Step Functions wait-and-poll loop. |
| D-06 | Low | Filters support only string `equals` and `in`, combined with AND. Numeric, boolean and range filters aren't exposed. | Extend `toRetrievalFilter` and the schema when needed, keeping the key allow-list. |
| D-07 | Low | The WAF `AWSManagedRulesCommonRuleSet` blocks bodies over **8 KB** (`SizeRestrictions_BODY`). `maxQueryLength` may be set up to 8000 characters, and multi-byte text can exceed 8 KB. | Keep `maxQueryLength` at or below about 2000, or override that rule to `count` for this API. |
| D-08 | Low | The AWS SDK is bundled (about 1 MB) and source maps are enabled, which costs some cold-start time. | This is an acceptable trade-off for version pinning and debuggability. Revisit if p99 latency matters. |
| D-09 | Low | One data source per knowledge base. | Add more `CfnDataSource`s (other prefixes or buckets) when needed. The ingestion handler would then take a data source id per message. |

---

## 3. Security architecture review

### 3.1 Assets, trust boundaries, data flows

| Asset | Classification (assumed) | Where |
|---|---|---|
| Source documents | Internal / confidential | S3 (SSE-KMS CMK, versioned) |
| Embeddings and chunk text | Same as source, since chunks are *copies* of the document text | S3 Vectors (SSE-KMS CMK) |
| Queries and answers | May contain personal data | In transit only. Not logged by default. |
| App client secrets | Credential | Cognito only. Never output, logged or committed. |
| Logs | Operational, may contain IPs | CloudWatch (CMK, 90-day retention) |

Trust boundaries:

1. Internet to WAF, then to API Gateway or the Cognito token endpoint.
2. API Gateway to the Lambda (IAM-invoked, scoped `SourceArn`).
3. Lambda to Bedrock (IAM, optionally PrivateLink).
4. Bedrock (service role) to S3, S3 Vectors and KMS.
5. Document writers to S3.

### 3.2 Controls in place

| Threat (STRIDE) | Control |
|---|---|
| Spoofing a caller | OAuth2 client credentials (Cognito). Per-route scopes enforced by API Gateway **and** re-checked in the Lambda. No self sign-up, no user auth flows. |
| Confused deputy | Bedrock role trust conditioned on `aws:SourceAccount` and `aws:SourceArn`. KMS service grants conditioned. Data source pins `bucketOwnerAccountId`. EventBridge grants are same-account. |
| Tampering in transit | TLS only: S3 and SQS deny non-TLS and TLS < 1.2. API Gateway uses an enhanced TLS 1.2/1.3 policy in STRICT mode. SNS is TLS-only. HSTS on responses. |
| Tampering at rest / wrong key | Deny uploads that request a non-stack key or SSE-S3. Bucket versioning. Optional writer allow-list (S-03). |
| Information disclosure | BPA plus ownership enforced. CMK everywhere, including log groups and Lambda env. Responses strip bucket names and Bedrock system metadata. No bodies in API logs (`dataTraceEnabled: false`). WAF logs redact `Authorization`. Queries not logged by default. |
| Denial of service and cost | WAF per-IP rate limit (API **and** token endpoint), stage throttling, Lambda reserved concurrency, request size caps, `maxResults` cap. |
| Elevation of privilege | Least-privilege roles with exact ARNs (KB, index, model, prefix). The only wildcards are AWS-mandated (X-Ray, `RetrieveAndGenerate`), each justified in `lib/nag-suppressions.ts`. |
| Repudiation | API access logs (IP, method, status, request id), Lambda logs with `client_id`, CloudTrail (account level). |
| Prompt injection (`/ask`) | Prompt template treats retrieved text as untrusted data. Optional Bedrock Guardrail. Stateless calls (no `sessionId`), so callers can't join other sessions. Retrieve-only by default. |
| Secrets in a public repository | Config is git-ignored, and only a placeholder template is tracked. `check-secrets.sh` scans for ARNs with account ids, access keys, private keys and tracked env configs (verified to catch a planted id). `cdk.context.json` is git-ignored. |

### 3.3 Open findings and recommendations

| ID | Sev | Finding | Recommendation |
|---|---|---|---|
| S-07 | **High** (before multi-tenant use) | **No document-level authorization.** Any client with the `retrieve` scope can retrieve every indexed chunk. That is fine for a single trust domain, but not otherwise. | Before onboarding a second data owner: tag documents with an owner or classification in `.metadata.json`, map Cognito clients to allowed values (custom scopes or a lookup), and have the Lambda **force** a filter derived from the token, which callers can't override. Alternatively, run a separate KB per domain. |
| S-08 | Medium | **Indirect prompt injection is mitigated, not eliminated.** Poisoned documents still reach agents through `/retrieve`, where the *caller's* model consumes them. | Set `writerPrincipalArns`. Treat `/retrieve` output as untrusted in every consuming agent (document this in agent guidelines). Enable a Guardrail with prompt-attack filters on `/ask`. Consider an ingestion-time scan (for example Macie for PII, or a content check) for high-risk sources. |
| S-09 | Medium | **Single CMK with the default key policy**, which delegates to account IAM, so any admin with `kms:*` can use it. It covers documents, vectors, queues and logs. | For production, separate a **data key** (S3, S3 Vectors) from an **ops key** (logs, SQS, SNS). Restrict key administration to a named role and usage to the workload roles. Consider an SCP that denies `kms:ScheduleKeyDeletion` and `kms:DisableKey`. |
| S-10 | Medium | **No vector bucket policy.** Access to S3 Vectors relies on IAM alone, so another principal with broad `s3vectors:*` could read embeddings and chunk text directly. | Add an `AWS::S3Vectors::VectorBucketPolicy` that denies data-plane actions (`GetVectors`, `QueryVectors`, `ListVectors`) to everyone except the KB service role and a break-glass role. Or enforce this with an SCP or permission boundary. |
| S-11 | Medium | **Long-lived client secrets** with manual rotation. | Distribute secrets through Secrets Manager to callers, document a rotation runbook (add client, migrate, remove), keep access-token validity short (default 60 min), and alarm on token-endpoint failures via WAF metrics. |
| S-12 | Low | The API is **internet-facing** by default. | If all callers are inside AWS, use a **private** API (`EndpointType.PRIVATE` with an `execute-api` VPC endpoint and a resource policy), or add a resource policy with source-IP or VPC conditions. |
| S-13 | Low | The KB role has `s3:ListBucket` on the whole bucket, which exposes object *names* outside the prefix. | Keep non-indexed data in a different bucket, or add an `s3:prefix` condition after confirming the Bedrock list behaviour. |
| S-14 | Low | API access logs contain **caller IP addresses** (personal data under UK GDPR). | Confirm the 90-day retention against your DPIA and RoPA, and adjust `logRetentionDays`. |
| S-15 | Low | **Account-level telemetry is outside this stack.** | Make sure the organization CloudTrail includes S3 data events for the document bucket and Bedrock data events where supported. If Bedrock *model invocation logging* is enabled at account level, it will capture prompts **with retrieved document text**, so encrypt and restrict that destination accordingly. |
| S-16 | Low | `removalPolicy: destroy` (used in the example for dev) deletes keys and data stores, after a 7-day KMS pending window. | Use `retain` (the default) for anything with real data. Termination protection is enabled automatically with `retain`. |
| S-17 | Info | WAF managed rules may produce false positives on technical queries (for example ones containing SQL or code). | Watch WAF metrics after launch, and set individual rules to `count` if needed. |

---

## 4. Pre-production checklist

These items can't be proven by synth or unit tests. Confirm each one on the
first deployment:

1. **Region support.** S3 Vectors, Bedrock Knowledge Bases with an S3 Vectors
   store, the embedding model, and the API Gateway enhanced security policy
   (`SecurityPolicy_TLS13_1_2_2021_06` with `STRICT` access mode) must all be
   available in the target region. If the enhanced policy isn't available,
   set `api.securityPolicy` to `TLS_1_2`.
2. **CMK flows work end to end.**
   - Ingestion succeeds. This exercises Bedrock → S3 decrypt, Bedrock → S3
     Vectors put with the CMK, and the S3 Vectors indexing principal.
   - Retrieval returns results.
   - An alarm notification arrives:
     `aws cloudwatch set-alarm-state --alarm-name <IngestDlq alarm> --state-value ALARM --state-reason test`.
     This validates the `cloudwatch.amazonaws.com` key-policy condition on the
     encrypted topic.
3. **Auth negative tests.** No token returns 401. A token without the right
   scope returns 403. A token from another resource server returns 403.
   Hammering the token endpoint trips the WAF rate rule.
4. **Writer allow-list.** If set, an unlisted role gets `AccessDenied` on
   `PutObject`, and the listed publisher role succeeds.
5. **Logs.** Query text is absent from Lambda, API and WAF logs, and the
   `Authorization` header is redacted in WAF logs.
6. **VPC mode** (if used). Lambdas reach Bedrock only through the endpoints,
   and endpoint policies don't block the calls you need.
7. **Run the secret scan before pushing:** `npm run check:secrets`. A
   pre-commit hook is recommended.

---

## 5. Accepted cdk-nag findings

All of them are in `lib/nag-suppressions.ts`, each scoped to the narrowest
construct and given a written reason:

- **AWS-managed Lambda logging policy:** `IAM4`.
- **AWS-mandated wildcards:** `IAM5` for X-Ray, `RetrieveAndGenerate`, and the
  cross-region inference-profile foundation-model ARN (conditioned on the
  profile ARN).
- **Read access under the document prefix:** `IAM5`.
- **Cognito Plus tier not needed:** `COG8`. There are no human users.
- **Opt-in execution logging:** `APIG6`. Access logs are always on.
- **Endpoint security group:** `EC23`. nag can't evaluate the SG-to-SG
  reference.
