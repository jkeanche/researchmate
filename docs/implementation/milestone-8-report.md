# Milestone 8 report: AI billing and payments

Date: 2 November 2026 · Blueprint phase 13

## What was built

**Pricing versions.**
- Platform administrators draft a version (target gross margin plus price lines: AI models per million input/output tokens, and external services per unit), review it, and activate it.
- Activating retires the previous version. **Active and retired versions can't be changed** (database triggers on versions and items). Every charge records the version it used.
- Customer price = provider cost ÷ (1 − target gross margin), rounded up to the micro-dollar; a per-line margin override is supported.
- Provider costs are entered by the administrator from the providers' current price lists. No prices are assumed or shipped.

**Ledger.**
- An append-only money ledger in micro-USD (`credit_ledger_entries`, with update/delete blocked by trigger), with unique idempotency keys so retries never double-charge or double-credit.
- Two pools: prepaid **credit**, which carries over, and the plan's monthly **included allowance** (`ai.platform.allowance`: Starter $1, Pro $5, Team $20, all configurable), which is used first.

**Platform-funded AI** (where the plan allows: `ai.platform` on Starter, Pro and Team).
- Funding is explicit per run. A chosen key is always BYOK, and BYOK is never charged by ResearchMate. Asking for BYOK without a key fails; it never quietly switches to credit, and a failed BYOK run never falls back to platform AI.
- Platform runs use the operator's model (`PLATFORM_AI_*`) **only if that model has an active price**. Output is capped (`PLATFORM_AI_MAX_OUTPUT_TOKENS`) so a single run's cost is bounded.
- Budget is checked when the run is queued (rough estimate) and again just before the provider call (estimate from the actual prompt). Estimates of queued and running jobs are held against the balance.
- The actual charge is computed from the provider's reported tokens at the run's pricing version, recorded on the run and in `usage_records`, and debited idempotently (allowance first, then credit).
- Each run records provider, model, user, organization, project, agent, tokens, provider cost, customer charge, pricing version, duration and status, as §23 lists.

**Spending limits.** Per-organization monthly cap and per-run cap, enforced together with available funds and amounts held by jobs in flight.

**External services metered separately (§24).** OCR pages from text extraction are recorded as their own usage kind, charged only if `ocr.pages` is priced in the active version. The billing page breaks usage down into AI (by agent, model and funding) and services. Apify, crawling and API costs plug into the same `meterService`.

**Payments (§25).** A provider abstraction with **Paystack** (cards, M-PESA, Apple Pay; KES/USD), **Pesapal** (cards, M-PESA, Airtel Money) and **Stripe** (for operators with a company in a Stripe country). The evaluation, with sources, is in `docs/architecture/payments.md`; Paddle eligibility for Kenyan sellers couldn't be confirmed.
- **Never trusts the browser.** The return redirect only triggers a server-side status check.
- Webhooks are authenticated: Paystack HMAC-SHA512, and Stripe signed timestamps with a 5-minute tolerance. Pesapal's unsigned IPN is used only as a prompt to check.
- Fulfilment happens only after the provider's API confirms the payment **with the amount and currency requested**; a mismatch fails the payment.
- Webhooks are idempotent. A redelivered event still settles a payment that an interrupted earlier delivery left pending.
- **Credits:** packs priced per currency by administrators (no automatic exchange rates). The seed creates USD packs; KES prices for M-PESA are added by an administrator.
- **Subscriptions:** prepaid month or year periods, which work with mobile money. Renewing early stacks onto the current period. Reminders go out 7 days before the end; after the end the plan is past due for a grace period, then reverts to the default plan with **nothing deleted** (over-limit content becomes read-only). There is also a "Don't renew" option.
- **Invoices and credit notes:** sequentially numbered, append-only, printable, with optional seller details (`INVOICE_ISSUER`).
- **Refunds** (platform administrators): partial or full, through the provider. For credit purchases only unspent credit can be refunded, and it is removed immediately.
- A worker schedule handles renewals and re-checks abandoned checkouts.

**UI.**
- **Settings → Billing:** plan and period, credit, allowance, month spend, platform AI price, buy (item and provider), spending limits, usage breakdown, payments and invoices.
- **Billing admin** (platform administrators): pricing versions with computed customer prices, drafting and activation, payments with "check with provider" and refunds.
- **AI assistant:** a "Pay with" choice between your keys and ResearchMate credit (with available balance); each run shows its charge.

## Found and fixed

- Raw SQL with `Date` parameters failed with this driver; timestamps are now passed as ISO strings.
- **Webhook robustness:** if processing stopped after the event was recorded, a redelivery would have been ignored and the payment never settled. Found through the E2E test, which reused a transaction id. Duplicates now still reconcile pending payments.
- Billing tests used the same model id as older AI tests while changing its active price, which could interfere when test files run in parallel. Given their own model id.
- I had written a tax statement into the invoice footer that I couldn't verify. Replaced with operator-configured issuer details.

## Data

Migration `0007_billing`: `pricing_versions`, `pricing_items`, `credit_ledger_entries`, `spending_limits`, `price_points`, `payments`, `payment_events`, `invoices`, `refunds`, and the invoice number sequence. Triggers make ledger entries and invoices append-only and pricing versions and items immutable once active. Also adds `pricing_version_id` and `estimated_charge_micros` to `ai_runs`, and `pricing_version_id` to `usage_records`. New entitlements: `ai.platform`, `ai.platform.allowance`.

## Tests

- `tests/billing.test.ts` (8 tests):
  - the margin formula, validation, immutability triggers and version retirement;
  - a platform run charged at the right price to the allowance, with the output cap reaching the provider (`max_tokens`), BYOK never charged, and no fallback;
  - Free refused; insufficient funds, the monthly cap, the per-run cap, held reservations, and BYOK-without-key refused;
  - OCR metered as a service (free when unpriced, charged when priced) in the breakdown;
  - Paystack: the return redirect grants nothing, forged signatures are refused, an early webhook grants nothing, the paid webhook credits once, duplicates are ignored, an interrupted redelivery still settles, and an invoice is issued;
  - Stripe: wrong signature, stale signature and amount mismatch are all refused;
  - Pesapal: an IPN on an unpaid order does nothing, then fulfils; plan periods stack; refunds are limited to unspent credit, with a credit note;
  - renewals: reminder once, past due, then the default plan.
- E2E `billing.spec.ts`: admin drafts and activates pricing → the owner buys US$25 credit with Paystack (hosted checkout simulated, provider API faked) → returning before payment grants nothing → a forged webhook gets 400 → payment, then a signed webhook (delivered twice) → credit $25 with one ledger entry and an invoice.

**Totals:** 172 unit/integration tests and 10 E2E tests passing; typecheck clean; production build succeeds.

## Before taking real money

Run one sandbox payment, webhook and refund per provider (`*_BASE_URL` for sandboxes), enter KES price points, set `INVOICE_ISSUER`, and seek tax advice on VAT/digital service tax for your customers. The platform doesn't compute taxes.
