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
