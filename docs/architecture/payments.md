# Payment providers: evaluation and design

Researched 2 November 2026. Provider terms change, so re-check eligibility and fees before launch.

## Evaluation

| Provider | Can a Kenya-registered business use it? | Methods | Currencies | Fees (published) | Decision |
|---|---|---|---|---|---|
| **Paystack** (owned by Stripe) | Yes. Generally available to all businesses in Kenya. | Cards (Visa, Mastercard, Amex), **M-PESA**, Apple Pay | Collect and settle in KES or USD | Local cards 2.9 %, international cards 3.8 %, M-PESA 1.5 %; no set-up or monthly fee; settlement T+2 | **Implemented: primary for Kenya** |
| **Pesapal** | Yes (Kenyan company, East Africa) | Cards, M-PESA, Airtel Money and others | KES, USD and regional currencies | Negotiated per merchant; not checked here | **Implemented: alternative**. API v3 has a documented server-side status check (`GetTransactionStatus`), which fits our verify-before-fulfil rule. |
| **Stripe** | No. Stripe's global page lists Kenya as "Extended network", which routes to Paystack. Direct Stripe accounts need a company in a supported country. | Cards (and Stripe's local methods in supported countries) | Many | Varies by country | **Implemented** for operators with a company in a Stripe-supported country. Off unless keys are set. |
| **Paddle** (merchant of record) | Unconfirmed. Paddle's public docs list buyer countries; the seller-country list is behind its partner login. Digital goods only. | Cards, PayPal and others | Many | Merchant-of-record pricing | **Not implemented.** Revisit if Paddle confirms Kenyan sellers; it would also handle sales tax/VAT. |
| **M-PESA Daraja** (Safaricom, direct) | Yes, needs a Paybill/Till and Safaricom onboarding | M-PESA STK push | KES | Safaricom tariffs | Not implemented; Paystack and Pesapal already give M-PESA without separate Safaricom onboarding. A Daraja adapter fits the same interface if needed. |

Sources:
- [Paystack Kenya pricing](https://paystack.com/ke/pricing)
- [Paystack is live for all merchants in Kenya](https://paystack.com/blog/company-news/kenya)
- [Stripe global availability](https://stripe.com/global)
- [IntaSend: Is Stripe available in Kenya? (2023)](https://intasend.com/payments/is-stripe-available-in-kenya-best-alternative-in-kenya)
- [Paddle supported countries](https://developer.paddle.com/concepts/sell/supported-countries-locales)
- [Paddle supported sellers](https://developer.paddle.com/partners/embed-billing/get-started/supported-sellers)
- [Pesapal API 3.0 GetTransactionStatus](https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/gettransactionstatus)
- [Hookdeck: Paystack webhooks](https://hookdeck.com/webhooks/platforms/guide-to-paystack-webhooks-features-and-best-practices)

## Design

- **One interface** (`packages/billing/src/providers.ts`) per provider:
  - create a checkout;
  - authenticate and parse a notification;
  - fetch the authoritative status;
  - refund;
  - identify the payment on the return redirect.
- **Never trust the browser.** The return redirect only triggers a server-to-server status check. Notifications are authenticated (Paystack HMAC-SHA512 of the raw body; Stripe `t=,v1=` HMAC-SHA256 with a 5-minute tolerance). Pesapal's IPN is unsigned, so it is treated purely as "go and check". In every case nothing is fulfilled until the provider's API confirms the payment, **with the amount and currency we asked for**; a mismatch fails the payment and is logged as an error.
- **Idempotency:**
  - every notification is recorded once per provider event id;
  - fulfilment happens under a row lock, only on the pending → succeeded transition;
  - ledger entries have unique idempotency keys;
  - a repeated event still settles a payment left pending by an interrupted earlier delivery.
- **Subscriptions are prepaid periods.** Mobile money has no recurring pull, so a plan is bought for a month or a year. Renewing early adds to the end of the current period. Reminders go out 7 days before the end. After the end the plan is `past_due` for a grace period (`BILLING_GRACE_DAYS`, default 3), then the organization returns to the default plan. **Nothing is deleted on downgrade**: over-limit content stays readable but is read-only.
- **Prices per currency are set by administrators** (`price_points`), never converted with an assumed exchange rate. The seed creates USD prices from the plans plus three credit packs. KES prices for M-PESA must be entered by an administrator.
- **Invoices** are numbered from a database sequence (`RM-YYYY-NNNNNN`), append-only, and include the provider reference. Refunds issue credit notes. Seller details come from `INVOICE_ISSUER`.
- **Refunds** are for platform administrators. For credit purchases only unspent credit can be refunded, and it is removed from the balance as the refund is requested.

## Configuration

| Variable | Purpose |
|---|---|
| `PAYSTACK_SECRET_KEY`, `PAYSTACK_CURRENCIES` (default `KES,USD`) | Enables Paystack. Webhook URL: `https://<domain>/api/payments/paystack/notify` |
| `PESAPAL_CONSUMER_KEY`, `PESAPAL_CONSUMER_SECRET`, `PESAPAL_IPN_ID` (optional; registered automatically if absent), `PESAPAL_CURRENCIES` | Enables Pesapal. IPN URL: `https://<domain>/api/payments/pesapal/notify` (GET) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CURRENCIES` (default `USD`) | Enables Stripe. Webhook: `checkout.session.completed` to `/api/payments/stripe/notify` |
| `*_BASE_URL` | Sandbox endpoints (e.g. Pesapal `https://cybqa.pesapal.com/pesapalv3`), or a test fake |
| `INVOICE_ISSUER` | Seller name, address and tax registration on invoices, separated by `|` |

**Not verified against the live providers.** The shell in this environment can't reach them. The adapters follow the providers' documented request, response and signature formats and are tested against a local fake that implements those formats. Before taking real money, run one sandbox payment, webhook and refund per provider.
