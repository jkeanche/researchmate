# Milestone 4 report: Google Drive and the AI foundation

Date: 2 November 2026 · Blueprint phases 8 and 9

## Google Drive (phase 8)

- **Connection.** OAuth 2.0 authorisation code flow with PKCE (S256), offline access and a `state` value checked against an encrypted, httpOnly, 10-minute cookie. The default scope is `drive.file`. `GOOGLE_DRIVE_SCOPE=drive.readonly` allows browsing all files but is a restricted scope that needs Google verification.
- **Tokens.** Refresh and access tokens are AES-256-GCM encrypted, bound to the user, and never sent to the browser. Expired access tokens are refreshed automatically. A revoked grant marks the account `reauth_required`. Disconnecting revokes the token at Google and wipes it locally.
- **Browse and import.** Search and browse the files ResearchMate can see. Imports go through the normal file service (permissions, quotas, content validation). Google Docs, Sheets and Slides are exported to DOCX, XLSX and PPTX. Imports are size-capped.
- **Duplicates and changes.** Re-importing an unchanged file creates no new copy. A file changed in Drive (new md5 or modified time) becomes a new version of the same ResearchMate file. This is the basis for later sync.
- **Export.** Export any accessible file to Drive, optionally into a folder, using a multipart upload.
- **Background jobs.** Imports and exports run as worker jobs (`drive_jobs`) with status and errors shown on the Integrations page.
- **Storage.** A Drive reference costs no storage; only imported copies count against quota.
- **Gating.** Requires the `integrations.google_drive` entitlement.

**Not verified against Google itself:** no OAuth client credentials are available in this environment. The integration is tested against a local fake that implements the same HTTP endpoints. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` (`https://<domain>/api/integrations/google/callback`) and do one manual connect/import/export before relying on it.

## AI foundation (phase 9)

- **Mastra.** `@mastra/core` 1.76.0. I verified the APIs against the current docs and the package's type definitions before building. Models are passed per request as `{ providerId, modelId, apiKey, url }`, so user keys never go through process environment variables.
- **Providers.** OpenAI, Anthropic, Google Gemini, and any OpenAI-compatible endpoint (self-hosted vLLM/Ollama/LM Studio, OpenRouter and similar).
- **Keys (BYOK).** Personal or organization-shared keys, encrypted at rest. Only the last four characters are ever shown again. Revocation overwrites the ciphertext. There is a "test key" button.
- **SSRF protection.** Custom endpoint URLs must be https and may not resolve to private, loopback, link-local, CGNAT or metadata addresses. `ALLOW_PRIVATE_ENDPOINTS=true` opts in for a model hosted on the same server.
- **No silent fallback.** A failed request with the user's key ends the run with a clear reason. There is no code path to another key or to platform-funded AI.
- **Platform-funded AI is deliberately not enabled in this release.** It needs pricing versions, spending limits and the billing ledger (phase 13). The flag `PLATFORM_AI_ENABLED` is reserved for that.
- **Agents.** Everything they produce is a suggestion; nothing writes to the project directly.
  - *Research Question Agent:* questions and aligned objectives.
  - *Risk Assessment Agent:* risks with likelihood, impact and mitigation.
  - *Project Planning Agent:* a schedule that is validated by the planning engine (cycles rejected, dependency violations repaired) and stored as a `schedule_proposals` row with `source = 'ai'`. An approver accepts it through the existing proposal flow, so AI can never move an existing task or an approved deadline.
  - *Research Coordinator:* answers questions using five read-only, project-scoped tools. Each tool re-checks the user's access, and the tools used are shown with the answer.
- **Prompt injection.** Project content is passed inside `<project_data>` delimiters with explicit instructions to treat it as data. The tools are read-only. Accepting a suggestion runs through the normal service with the user's own permissions.
- **Background execution.** Runs are queued in the `ai` BullMQ queue and executed by the worker. Status updates appear live on the AI assistant page, and runs can be cancelled; a result that arrives after cancellation is discarded. Transient provider errors (429, 5xx, network) are retried inside the AI call with backoff (AI SDK behaviour); auth and validation errors are not retried.
- **Metering.** Every run records provider, model, tokens, duration, tool calls and attempts. `usage_records` gets one idempotent row per run. BYOK runs are never charged by the platform (`customer_charge_micros = 0`). A provider-cost estimate is shown only when an administrator has entered that model's price in `ai_models`; prices are never assumed.
- **Plans.** Free: no AI. Starter: 50 runs a month (`ai.runs.monthly`). Pro and Team: unlimited. The monthly limit is checked under an organization lock, so concurrent starts can't exceed it.

## Migration `0003_ai_drive`

New tables: `ai_models`, `user_api_credentials`, `ai_runs`, `ai_run_steps`, `ai_suggestions`, `usage_records` (unique per source and kind), `connected_accounts` (one live connection per user, org and provider), `external_file_references`, `drive_jobs`.

New entitlement: `ai.runs.monthly`.

New environment variables: `GOOGLE_DRIVE_SCOPE`, `ALLOW_PRIVATE_ENDPOINTS`, `PLATFORM_AI_ENABLED` (reserved). `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` are now read.

## Tests

| Suite | Result |
|---|---|
| `tests/ai.test.ts` (10), against a local OpenAI-compatible mock speaking the real HTTP protocol, including tool calls | Key encryption and visibility; SSRF guard; key test; plan gating, no-key path and Starter cap; risk agent suggestions → accept, with metering idempotent and BYOK never charged; question/objective linking; planning proposal repaired and cycles rejected; assistant tools recorded; 401 fails with exactly one request; 503 recovered within the call; cancellation; permissions and tenant isolation. Passed |
| `tests/drive.test.ts` (6), against a local fake Google | Plan gating, PKCE and scope; encrypted tokens; import incl. Google Doc → DOCX, duplicate detection, new version on change; quota enforcement and clear errors; export with token refresh; revoked grant → reconnect; disconnect revokes. Passed |
| All unit and integration tests | **137 passed** |
| E2E `ai.spec.ts` | Key UI (only the hint is displayed) → key test → risk agent via queue and worker → accept → appears in the risk register. Passed |
| All E2E tests | **6 passed** |

## Findings during the work

- The Mastra docs only show models as `provider/model` strings with environment-variable keys. The package types revealed per-request `{ providerId, modelId, apiKey, url }` support, which I confirmed against the mock before building on it.
- The AI SDK always retries 5xx responses internally (3 attempts), and no Mastra option I tried disables that. The design was changed so the job queue doesn't add a second layer of retries.

## Known limitations

- Google Picker isn't integrated. With `drive.file`, users see only files ResearchMate created or that they opened with it. Picker support would add a Google script origin to the CSP.
- AI budget suggestions, AI document processing and embeddings come with phases 10, 11 and 13.
- Conversations with the assistant are single questions; there is no chat memory.
- DNS rebinding: endpoint URLs are re-validated when each run starts, but the connection is not pinned to the validated IP.
