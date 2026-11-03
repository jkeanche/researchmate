# Blueprint review

A review of the ResearchMate AI blueprint before implementation, with the decision taken for each finding. Items marked **(M1)** were resolved in milestone 1; the rest are carried into the milestone where they apply.

## Gaps and contradictions

1. **Entitlement subject: user or organization?** §22 defines `canUseFeature(userId, …)` while §5 makes subscriptions organization-level. A user in two organizations on different plans has no single answer. **Decision (M1):** entitlements are resolved per *organization* (the billing tenant). Service functions take `organizationId`; the caller's membership is checked separately.

2. **Free limits can be multiplied.** "One project, one file per account" is bypassable if a user can create unlimited free organizations. **Decision (M1):** a user may own at most one organization on a zero-price plan. Additional organizations require an upgrade (or an administrator).

3. **Archiving as a quota bypass.** If archived projects stopped counting, a Free user could archive and recreate indefinitely. **Decision (M1):** every project counts toward `projects.max`, including archived ones. Documented in the UI.

4. **"Optional" plan cells are undefined.** Starter → Budget "Optional", Pro → Apify "Optional" etc. have no defined mechanism. **Decision (M1):** modelled as `false` in the plan, enabled per organization through administrator entitlement overrides (with reason and optional expiry). Becomes a purchasable add-on when billing lands.

5. **Downgrade policy is required but unspecified.** **Decision (M1):** nothing is ever deleted. Over-limit organizations keep full read/download access; any action that would add to an exceeded limit is refused. The dashboard and organization page show which limits are exceeded.

6. **Storage accounting for versions and deletions.** The spec requires versioning and quotas but not how they interact. **Decision (M1):** every stored version counts toward storage. Deleting a file releases its quota immediately; stored bytes are erased by the worker after `FILE_RETENTION_HOURS` (default 72), and metadata is kept for audit.

7. **Concurrent upload quota.** **Decision (M1):** uploads reserve quota inside a transaction holding a row lock on the organization; reservations expire after 30 minutes if an upload is abandoned. A test proves six concurrent uploads on the Free plan yield exactly one file (and fails if the lock is removed).

8. **Email verification on GET.** Link scanners in email clients pre-fetch links and would consume single-use tokens. **Decision (M1):** verification is a button (POST) on the page the link opens.

9. **Separate `researchmate-scheduler` service.** BullMQ job schedulers are idempotent and live in Redis, so a separate container adds failure modes without benefit at this scale. **Decision (M1):** the worker registers schedules on start; running several workers does not duplicate them.

10. **Mastra in Phase 1 vs "don't start with agents".** Installing Mastra before any agent exists adds an unused dependency (§36.15). **Decision:** Mastra is introduced in Phase 9 with the provider registry and metering, after verifying its then-current APIs.

11. **S3 in milestone 1.** The S3 driver can't be verified without a real bucket in this environment, and §36.18 forbids claiming untested integrations. **Decision:** the storage driver interface is in place; S3 ships in Phase 4 with tests against MinIO. Selecting `STORAGE_DRIVER=s3` now fails loudly at startup.

12. **Gantt "Basic overview" on Free contradicts "overview-only" free plan.** Kept as a tier (`planning.gantt = overview`) so Phase 6 can render a read-only timeline without a plan-name check.

## Risks to plan for

- **AI cost exposure.** BYOK + platform AI + target margin needs the ledger (Phase 13) *before* platform-funded AI is enabled for any paid plan; otherwise Starter's "Limited AI" has no enforceable meaning. Recommend shipping Phase 9 with BYOK only, and platform AI after Phase 13.
- **Statistical tooling.** "Use deterministic tools" implies a sandboxed execution service (e.g. a Python/R worker in a locked-down container). This is an infrastructure project in itself; scope it before Phase 15.
- **Kenyan payments.** Stripe availability for Kenyan merchants is limited; Pesapal / M-Pesa (Daraja) support for recurring billing differs from card subscriptions. Validate the payment abstraction against at least one mobile-money provider early in Phase 13.
- **Document fidelity.** PDF page-count validation via LibreOffice headless needs its own container and a font policy (institution templates often require Times New Roman). Plan the font licensing question early.
- **Scope.** 16 phases and ~100 tables is several engineer-years. The phase order is sound; resist pulling AI agents forward.

## Smaller corrections

- §27 lists `roles`/`permissions` but no join table; implemented as `role_permissions`.
- §13 suggests `/var/lib/researchmate/backups` on the same disk as the data; backups must be copied off-server (documented in the deployment guide).
- §26 mentions "reauthentication for disabling"; implemented as password **and** a current TOTP/recovery code.

## Milestone 2 findings

13. **"Gantt planning: Basic overview" on Free (§22) vs "Free is overview-only".** **Decision (M2):** the Free tier can keep a small plan (20 tasks and milestones per project via `planning.tasks.max`) with list, board, calendar and a read-only timeline. Dependencies, drag scheduling, critical path, baselines, proposals, risks, events and time tracking need `planning.gantt = full`.

14. **§27 lists `research_milestones` separately from tasks.** **Decision (M2):** milestones are tasks with `kind = milestone`, so dependencies and the critical path work uniformly.

15. **"Do not let AI silently change approved deadlines" (§8.2) needs a mechanism before AI exists.** **Decision (M2):** locked deadlines (`deadline_locked`), approver-only overrides with a recorded reason, and proposals that never edit existing tasks. A future AI agent writes proposals with `source = 'ai'`; it gets no path to move a locked date.

16. **"Do not overwrite the original baseline" (§8.5).** **Decision (M2):** numbered, append-only baselines; database triggers refuse updates and deletes.

17. **Working days vs calendar days** is unspecified. **Decision (M2):** calendar days for now (stated in every generated proposal). Institution/country calendars are a later enhancement.

18. **Supervisor waiting time (§7)** has no data source. **Decision (M2):** measured from approval-gated workflow stages (time in `awaiting_approval`). Supervisor document review (Phase 12) will add to it.

19. **"Export to PDF" for Gantt (§8.1).** **Decision (M2):** PNG/SVG export in the browser and a print-to-PDF layout. Server-generated PDFs come with the document engine (Phase 11), which needs a LibreOffice/Chromium container anyway.

20. **Self-approval.** A lead researcher working alone holds `project.plan.approve` and can approve their own stages and schedules; otherwise single-person projects could never progress. Organizations that need four-eyes approval can give the lead a researcher role and a supervisor the approval role; an "approver must differ from submitter" rule can be added with supervisor collaboration (Phase 12).

21. **Gantt library (§3).** Evaluated maintained options; none met the four-dependency-type, baseline and server-validated-drag requirements under a permissive licence without paid tiers. Built in-house over SVG (see architecture decisions).

22. **"Never fabricate sources, quotes or evidence" (§10) is stated as a rule for AI.** **Decision (M5):** enforced in code after every AI response. Quotes must occur verbatim in the extracted document, and citation keys must exist in the project library. Failing output is discarded, not repaired.

23. **Verification levels (§10) don't say who may set them.** **Decision (M5):** software sets at most "metadata verified" (a DOI registry match); "full text reviewed" is a person's statement and needs the full text attached.

24. **The literature matrix could overstate what was read.** **Decision (M5):** each row records its basis (metadata, abstract or full text), which can't exceed the content held for that source.

25. **Semantic search over documents.** **Decision (M5):** PostgreSQL full-text search with page numbers now; embeddings later on the same `file_passages` table when pgvector is available.

26. **"Use DOCX as the editable master format" vs a web editor (§18).** **Decision (M6):** the web editor stores structured section markup that maps one-to-one to DOCX; DOCX is generated from it and is the file people edit outside ResearchMate. Round-tripping edited DOCX back into sections is not supported, to avoid silent loss of structure.

27. **"Validate the actual output" (§18).** **Decision (M6):** validation reads the rendered PDF itself (pdf.js): page size and count, margins (text and image bounding boxes), headings in order, contents, captions, drawn images and printed page numbers. Content limits use the same model that produced the DOCX.

28. **Word-count convention** is unspecified. **Decision (M6):** main-text words only; citations, tables, captions, equations, preliminary pages, references and appendices are excluded, and the rule is shown with every count. Abstract and per-section limits are separate.

29. **Unknown citations.** **Decision (M6):** allowed while drafting (highlighted), but they block export. "Every citation must point to a reference record" (§19) holds for every exported file.

30. **Equations.** **Decision (M6):** TeX-like input rendered as text with Unicode symbols and right-aligned numbers. True Word math (OMML) is a later enhancement.

31. **"AI … cannot impersonate a supervisor or automatically approve research" (§21).** **Decision (M7):** decisions are a person's action with the review permission, never the submitter's (database check). The Supervisor Feedback Agent only creates suggestions, which the researcher accepts as revision tasks; it has no path to decisions.

32. **External supervisors.** **Decision (M7):** invited supervisors join the organization as `org_member`, which grants no access beyond the projects they're added to, and count towards the member limit. Invitations are bound to the invited email address.

33. **"Limited" supervisor collaboration on Starter.** **Decision (M7):** one supervisor per project (including pending invitations); full review workflow otherwise. Collaborator invitations follow `collaboration.team`, which is off on Starter.

34. **"Evaluate Stripe, Paddle, Pesapal and Kenyan options" (§25).** **Decision (M8):** Paystack (primary) and Pesapal for Kenya, Stripe for operators in Stripe countries, Paddle not implemented (seller eligibility unconfirmed). See `docs/architecture/payments.md`.

35. **Subscriptions with mobile money.** M-PESA has no recurring pull. **Decision (M8):** plans are prepaid periods with reminders and stacking renewals, instead of card-only auto-renewal.

36. **Currency conversion.** **Decision (M8):** no automatic exchange rates for prices; administrators set prices per currency. AI costs and credit are in USD (providers bill in USD).

37. **"checkAiBudget(userId, estimatedCost)" (§22).** **Decision (M8):** budgets are per organization (credit, allowance, monthly and per-run caps), checked at queue time and again with the real prompt before the provider call, with amounts held by jobs in flight; output tokens are capped so the estimate is an upper bound on output.

38. **Prices are not shipped.** Provider prices change and none are assumed. Platform AI stays unavailable until an administrator activates a pricing version that includes the configured model.

39. **MCP transports.** **Decision (M9):** remote Streamable-HTTP servers only. Local (stdio) servers would run arbitrary programs on our infrastructure. A self-hosted server can be exposed over HTTP and registered with `ALLOW_PRIVATE_ENDPOINTS`.

40. **"Approved external actions" for MCP.** **Decision (M9):** tools are approved one by one with their schemas frozen; the assistant only sees approved tools; calling requires edit rights on the project; every call is audited.

41. **Apify Actor choice.** **Decision (M9):** platform-level allowlist with strict input contracts. Seeds are disabled until an administrator verifies them against the Actors' current documentation.

42. **"Use established statistical libraries or sandboxed execution services" (§10.3).** **Decision (M10):** in-process implementations of the common tests, using jStat for distributions, verified against SciPy. No user-supplied code is executed. Qualitative coding, histograms and scatter plots, and analysis scripts in R or Python are deferred.

43. **Survey responses (§10.4).** **Decision (M10):** questionnaires are designed and exported (Word, plus an XLSX codebook and data-entry sheet); responses are collected outside ResearchMate and can be imported as a dataset. Public survey links, response summaries and collection status need participant-data handling (consent records, retention) and are deferred. Nothing implies ethics approval.

44. **Methodology and reporting tools (§10.5, §10.9).** **Decision (M10):** shipped the sample-size calculators (with formulas and assumptions), the proposal, progress and defense decks and the status report. Design comparison, operationalisation and alignment matrices, checklists, posters and executive summaries are deferred.

45. **Notifications, search and retention had no phase (§30, §31, §29).** **Decision (M11):** built in the hardening milestone, since production needs them: notifications with preferences, project/workspace full-text search, workspace deletion with a 30-day grace and account pseudonymisation. pgvector semantic search is deferred.

46. **"Malware scanning where available" (§29).** **Decision (M11):** optional ClamAV (clamd INSTREAM), fail closed when configured but unreachable.

47. **Financial record retention after deletion.** **Decision (M11):** invoices, payments and ledger entries are copied to an immutable `retained_financial_records` table before an organization is purged; the retention period is the operator's (jurisdiction-specific), documented in the deployment guide.

48. **Remaining dependency advisories.** zod 3.x (no patched 3.x release; request bodies are size-capped; migrate to zod 4) and minimatch via exceljs's archiver (unused code path).

