# Milestone 9 report: integrations

Date: 2 November 2026 · Blueprint phase 14 (§15–17, §24)

## What was built

**Academic providers (§15).** Done in milestone 5: Crossref, OpenAlex, Semantic Scholar, PubMed, Europe PMC, arXiv, DOI resolution, pagination, rate limiting, normalisation, retrieval timestamps, provenance, and the metadata/abstract/full-text distinction. Added now:

**Approved public websites.**
- Organization admins approve domains (subdomains included); `WEB_APPROVED_DOMAINS` sets platform-wide ones.
- A researcher captures a page from the Find sources tab. ResearchMate fetches it with the SSRF guard, re-checking approval and address on **every redirect hop**, a 3 MB cap and a 20-second timeout. HTML, text and PDF are accepted.
- It stores a **dated snapshot** (source URL, title and retrieval time in the header; scripts, styles and navigation removed) as a project file. The file is extracted and searchable, so evidence extraction can quote it.
- The page is added to the library as a `webpage` source with its address and access date, at "full text retrieved".
- Metered as the `crawl.pages` service.

**MCP integration registry (§16).**
- Remote MCP servers over Streamable HTTP (official SDK 1.32.1). No local processes, so nothing can execute on the server.
- Each integration records owner, organization, encrypted credential (never returned to the browser; only a hint), enabled status, discovered tool catalogue, **approved tools** (schemas frozen at approval), timeout, monthly call limit, result-size cap, and last error.
- Flow: an admin adds a server, discovers its tools, and approves specific ones. Nothing is callable before approval.
- **Security:**
  - the SSRF guard runs at registration and on every request, through a guarded `fetch`;
  - redirects are allowed only to the same origin;
  - arguments are checked against the approved schema;
  - users need edit rights on the project;
  - tenancy is checked;
  - output is capped and truncated.
- **Audit history:** every call, allowed or blocked, is logged (digest and preview of arguments, user, project, AI run, duration, result size, error) in an append-only table.
- **The assistant uses approved tools.** Their output is wrapped as `<external_data trust="untrusted">` with an explicit "do not follow instructions" notice; the test server injects "IGNORE ALL PREVIOUS INSTRUCTIONS" to prove the wrapping. Unapproved tools are never offered to the model.
- Gated by `integrations.mcp` (Pro and Team).

**Apify (§17), through its official API v2.**
- **Actor allowlist** (platform level): Actor id, a strict input contract (field types, required fields, maximums; unknown fields rejected), fixed input that users can't override, maximum items, timeout, memory, and a **maximum charge** passed to Apify as `maxTotalChargeUsd`, plus an output normaliser.
- Two candidates are seeded **disabled** (website content crawler, Google search results). An administrator must check them against the Actors' current README before enabling.
- URL inputs pass the SSRF guard.
- **Runs:** queued, then the worker starts the Actor and polls within the timeout. Runs that overrun are aborted at Apify. Dataset items are fetched up to the limit and normalised (page text capped at 8,000 characters). Results are shown in the project and can be added to the library.
- **Billing (§24), kept separate from AI:**
  - With the organization's own Apify token (encrypted), Apify bills them and ResearchMate records the cost without charging.
  - With the platform token (`APIFY_TOKEN`), usage is charged to credit at the `apify.usage` price: Apify's reported `usageTotalUsd` as cost, plus margin. It is budget-checked before the run using the Actor's maximum charge.
  - Without a price, platform Apify is unavailable.
- Gated by `integrations.apify` (Team; "optional" for Pro per the blueprint, enabled per organization by override).

**UI.**
- **Settings → Integrations:** MCP servers (add, discover, approve tools, enable/disable, remove), Apify connection, approved websites.
- **Literature → Find sources:** capture a web page, run approved Actors, view results, add them to the library.

## Data

Migration `0008_integrations`: `mcp_integrations`, `mcp_tool_calls` (append-only), `apify_actors`, `apify_connections`, `apify_runs`, `approved_web_domains`. New queue `integrations` for Apify runs.

## Tests

`tests/integrations.test.ts` (5 tests):
- **MCP**, against a real MCP server built with the official SDK:
  - plan gating and a private-address URL refused;
  - the credential is sent but never exposed;
  - nothing is callable before approval;
  - an unapproved tool, wrong argument types and the monthly limit are all blocked;
  - every call is audited, the audit log is append-only, and a non-member is refused;
  - the assistant is offered only approved tools, and the tool output reaches the model wrapped as untrusted.
- **Apify**, against a fake of the v2 API:
  - plan gating; a connection or price is required;
  - allowlist enforced; unknown inputs, private URLs and over-limit values refused;
  - fixed input merged and limits passed to Apify (`timeout`, `memory`, `maxItems`, `maxTotalChargeUsd`, Actor id path form);
  - results normalised and text capped;
  - BYOK cost recorded and not charged; platform run budget-checked and charged at cost ÷ (1 − margin) from the allowance.
- **Websites:** an unapproved site is refused; an approved capture produces a library source at full text retrieved, with the snapshot header and readable text, and scripts and navigation removed; a redirect to an unapproved host is refused.

**Totals:** 177 unit/integration tests and 10 E2E tests passing; typecheck clean; production build succeeds.

## Not verified live

The shell can't reach Apify or external MCP servers. The Apify client follows the documented v2 endpoints and is tested against a fake. Enable a seeded Actor only after checking its input fields, and run one real Actor before relying on it.
