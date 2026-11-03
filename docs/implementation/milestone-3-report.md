# Milestone 3 report: optional project finances

Date: 2 November 2026 · Blueprint phase 7

## Delivered

- **Optional per project.** Off by default. Turned on per project by someone with `finance.manage`, gated by the `finance.budget` entitlement (Research Pro and Team; Starter by override). Turning it off hides the records but keeps them. Unfunded projects can record costs with no budget.
- **Budgets with versions.** A draft is edited line by line per category, then an approver (`finance.approve`) approves it. Approval freezes it at the database level. A revision starts from the approved lines; approving it marks the old version superseded, never changed. Multiple funding sources can be split across allocation lines (supported by the service; the page currently edits unsplit category totals).
- **Categories.** The 24 from §9.2, plus organization-specific custom categories.
- **Expenses.** Statuses: draft → submitted → approved or rejected → paid → reimbursed, with cancellation (a reason is required) and a full approval history. Each expense records receipt files, task link, funding source, vendor, payment method, recurring flag and notes. Only drafts and rejected expenses are editable, with optimistic concurrency. Self-approval is allowed for solo researchers but flagged in the history and the expense report.
- **No double counting.** Every expense sits in exactly one bucket by status: pending (submitted), committed (approved, unpaid) or actual (paid or reimbursed).
- **Funding.** Sources of six types, awards, reporting periods, and append-only receipts (corrected by negative entries with a reason). The page shows received vs outstanding and spending per source.
- **Multi-currency.** Amounts are integer minor units in their own currency. The rate, rate date and converted base amount are stored at the time of entry and never re-converted. Rates are entered by the user, never fetched or guessed. Stored rates work in either direction. The reporting currency is locked once money exists.
- **Gantt link.** Task cost estimates by category, kept separate from spending. Forecast = actual + committed + pending + the outstanding estimates of unfinished tasks. Rescheduling changes the forecast inputs but never the approved budget.
- **Dashboard.** Approved budget, actual, committed, pending, remaining, % used with a configurable alert threshold, funding received, forecast, a per-category table (budget, estimates, actual, committed, pending, remaining) and monthly spending.
- **Reports.** Budget summary, expenses, category, planned vs actual, funding utilisation, monthly and grant reports, each as CSV, XLSX or PDF. CSV neutralises cells that would run as spreadsheet formulas.
- **Safeguards.**
  - Finance permissions are separate from research permissions: org admins see research but not money; finance managers see money but cannot edit research.
  - `financial_audit_events` stores before/after snapshots and is append-only (enforced by a trigger).
  - Triggers also enforce: approved budgets are immutable, and funding receipts are append-only.

## Migration `0002_finance`

New tables: `project_budget_settings`, `budget_categories`, `funding_sources`, `funding_transactions`, `budget_versions`, `budget_allocations`, `project_expenses`, `expense_attachments`, `expense_approvals`, `task_cost_estimates`, `exchange_rates`, `financial_audit_events`.

Partial unique indexes allow one approved and one draft budget per project.

Triggers: `rm_budget_version_guard`, `rm_budget_allocation_guard`, `rm_append_only`.

The blueprint's `budget_forecasts` table is not needed: forecasts are computed live from current data, so they can never go stale.

## Tests

| Suite | Result |
|---|---|
| `tests/finance.test.ts` (12) | Exact money parsing and conversion; optional/entitlement gating; permission separation and tenant isolation; budget versioning plus database-level immutability; approval workflow and exclusive buckets; FX storage and no re-conversion; funding reconciliation and append-only receipts; task estimates vs rescheduling; receipts limited to project files; all 7 reports in CSV/XLSX/PDF, with formula neutralisation |
| All unit and integration tests | **121 passed** |
| E2E `finance.spec.ts` | Free plan shows the upgrade notice → Pro → enable → budget → approve → expense submit/approve/pay → dashboard figures → report downloads in PDF, XLSX and CSV. Passed |
| All E2E tests | **5 passed** |

A browser-based duplicate-id scan across all project pages found five forms sharing element ids, which broke label targeting (finance, research, workflow, risks). All fixed. `Field` now accepts an explicit `id`.

## Known limitations

- Expenses are recorded by finance managers. A lighter "submit a claim" permission for research assistants is a sensible follow-up.
- The budget editor edits category totals. Splitting a category across funding sources works in the service but has no form yet.
- AI budget suggestions arrive with the AI milestone. The `task_cost_estimates.source` column is already ready to label them.
- Budget-threshold and pending-approval email notifications arrive with the notification system. The alert is shown on the page today.
- Not an accounting system: there is no double-entry bookkeeping, tax handling or statutory reports.
