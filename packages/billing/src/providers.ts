import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@researchmate/shared";

/**
 * Payment provider abstraction. A browser redirect is never proof of
 * payment: notifications are authenticated (signature) and, whatever they
 * say, the payment's status is always fetched from the provider's API
 * server-to-server before anything is fulfilled.
 */

export interface CheckoutInput {
  reference: string;
  amountMinor: number;
  currency: string;
  description: string;
  customerEmail: string;
  customerName?: string;
  returnUrl: string;
  cancelUrl: string;
  notifyUrl: string;
}

export interface VerifiedPayment {
  status: "succeeded" | "failed" | "pending" | "refunded";
  amountMinor: number | null;
  currency: string | null;
  providerReference: string | null;
  /** Provider's own wording, kept for support. */
  providerStatus: string;
  details: Record<string, unknown>;
}

export interface IncomingRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export interface NotificationRef {
  /** Provider event id when the provider has one (Stripe, Paystack). */
  eventId: string | null;
  type: string;
  reference: string | null;
  providerReference: string | null;
}

export interface PaymentProvider {
  readonly key: string;
  readonly name: string;
  /** Currencies this configuration accepts. */
  readonly currencies: string[];
  readonly methods: string;
  createCheckout(input: CheckoutInput): Promise<{ redirectUrl: string; providerReference: string | null }>;
  /** Authenticates and parses a webhook/IPN. Throws on anything not authentic. */
  parseNotification(req: IncomingRequest): Promise<NotificationRef>;
  /** What the provider expects as the HTTP response to a notification. */
  notificationResponse(ref: NotificationRef): { status: number; body: string; contentType: string };
  verify(p: { reference: string; providerReference: string | null }): Promise<VerifiedPayment>;
  refund(p: { reference: string; providerReference: string | null; details: Record<string, unknown> }, amountMinor: number, currency: string, reason: string): Promise<{ status: "succeeded" | "pending" | "failed"; providerReference: string | null }>;
  /** Identifies the payment on the return redirect (used only to trigger verification). */
  fromReturn(query: URLSearchParams): { reference: string | null; providerReference: string | null };
}

type Fetcher = typeof fetch;
const json = async (res: Response, provider: string) => {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new AppError("INTERNAL", `${provider} returned an unreadable response (${res.status}).`);
  }
  if (!res.ok) throw new AppError("INTERNAL", `${provider} rejected the request (${res.status}): ${String((body as { message?: string; error?: { message?: string } }).message ?? (body as { error?: { message?: string } }).error?.message ?? "").slice(0, 200)}`);
  return body as Record<string, unknown>;
};
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
/** Minor units → provider decimal string, for currencies with 2 decimals. */
const major = (minor: number) => (minor / 100).toFixed(2);

// ---------------------------------------------------------------------------
// Paystack (Kenya, Nigeria, Ghana, South Africa…): cards, M-PESA, Apple Pay
// ---------------------------------------------------------------------------

export class PaystackProvider implements PaymentProvider {
  readonly key = "paystack";
  readonly name = "Paystack";
  readonly methods = "Card, M-PESA, Apple Pay";
  constructor(
    private readonly opts: { secretKey: string; currencies: string[]; baseUrl?: string; fetch?: Fetcher },
  ) {}
  get currencies() {
    return this.opts.currencies;
  }
  private get base() {
    return (this.opts.baseUrl ?? "https://api.paystack.co").replace(/\/$/, "");
  }
  private call(path: string, init: RequestInit = {}) {
    return (this.opts.fetch ?? fetch)(`${this.base}${path}`, { ...init, headers: { authorization: `Bearer ${this.opts.secretKey}`, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  }

  async createCheckout(i: CheckoutInput) {
    const body = await json(await this.call("/transaction/initialize", { method: "POST", body: JSON.stringify({ email: i.customerEmail, amount: i.amountMinor, currency: i.currency, reference: i.reference, callback_url: i.returnUrl, metadata: { reference: i.reference, description: i.description } }) }), this.name);
    const data = body.data as { authorization_url?: string } | undefined;
    if (!body.status || !data?.authorization_url) throw new AppError("INTERNAL", "Paystack didn't return a checkout link.");
    return { redirectUrl: data.authorization_url, providerReference: null };
  }

  async parseNotification(req: IncomingRequest): Promise<NotificationRef> {
    const sig = req.headers.get("x-paystack-signature") ?? "";
    const expected = createHmac("sha512", this.opts.secretKey).update(req.body).digest("hex");
    if (!sig || !safeEq(sig, expected)) throw new AppError("FORBIDDEN", "Invalid Paystack signature.");
    const ev = JSON.parse(req.body) as { event?: string; data?: { id?: number | string; reference?: string; transaction_reference?: string; transaction?: { reference?: string } } };
    const reference = ev.data?.reference ?? ev.data?.transaction_reference ?? ev.data?.transaction?.reference ?? null;
    return { eventId: `${ev.event}:${ev.data?.id ?? ""}:${reference ?? ""}`, type: String(ev.event ?? "unknown"), reference, providerReference: null };
  }

  notificationResponse() {
    return { status: 200, body: "ok", contentType: "text/plain" };
  }

  async verify(p: { reference: string }): Promise<VerifiedPayment> {
    const body = await json(await this.call(`/transaction/verify/${encodeURIComponent(p.reference)}`), this.name);
    const d = (body.data ?? {}) as { status?: string; amount?: number; currency?: string; id?: number; channel?: string; reference?: string };
    const s = String(d.status ?? "");
    const status = s === "success" ? "succeeded" : s === "reversed" ? "refunded" : ["failed", "abandoned"].includes(s) ? "failed" : "pending";
    if (d.reference && d.reference !== p.reference) throw new AppError("INTERNAL", "Paystack returned a different transaction.");
    return { status, amountMinor: typeof d.amount === "number" ? d.amount : null, currency: d.currency?.toUpperCase() ?? null, providerReference: d.id != null ? String(d.id) : null, providerStatus: s, details: { channel: d.channel ?? null } };
  }

  async refund(p: { reference: string }, amountMinor: number, _currency: string, reason: string) {
    const body = await json(await this.call("/refund", { method: "POST", body: JSON.stringify({ transaction: p.reference, amount: amountMinor, merchant_note: reason.slice(0, 200) }) }), this.name);
    const d = (body.data ?? {}) as { status?: string; id?: number };
    return { status: d.status === "processed" ? "succeeded" : body.status ? "pending" : "failed", providerReference: d.id != null ? String(d.id) : null } as const;
  }

  fromReturn(q: URLSearchParams) {
    return { reference: q.get("reference") ?? q.get("trxref"), providerReference: null };
  }
}

// ---------------------------------------------------------------------------
// Pesapal (Kenya and East Africa): cards, M-PESA, Airtel Money, bank
// ---------------------------------------------------------------------------

export class PesapalProvider implements PaymentProvider {
  readonly key = "pesapal";
  readonly name = "Pesapal";
  readonly methods = "Card, M-PESA, Airtel Money";
  private token: { value: string; expires: number } | null = null;
  private ipnId: string | null;
  constructor(
    private readonly opts: { consumerKey: string; consumerSecret: string; currencies: string[]; ipnId?: string | null; baseUrl?: string; fetch?: Fetcher },
  ) {
    this.ipnId = opts.ipnId ?? null;
  }
  get currencies() {
    return this.opts.currencies;
  }
  private get base() {
    return (this.opts.baseUrl ?? "https://pay.pesapal.com/v3").replace(/\/$/, "");
  }
  private async auth() {
    if (this.token && this.token.expires > Date.now() + 30_000) return this.token.value;
    const body = await json(await (this.opts.fetch ?? fetch)(`${this.base}/api/Auth/RequestToken`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ consumer_key: this.opts.consumerKey, consumer_secret: this.opts.consumerSecret }), signal: AbortSignal.timeout(20_000) }), this.name);
    if (!body.token) throw new AppError("INTERNAL", `Pesapal authentication failed${body.error ? `: ${JSON.stringify(body.error).slice(0, 160)}` : ""}.`);
    this.token = { value: String(body.token), expires: Date.parse(String(body.expiryDate ?? "")) || Date.now() + 4 * 60_000 };
    return this.token.value;
  }
  private async call(path: string, init: RequestInit = {}) {
    const token = await this.auth();
    return json(await (this.opts.fetch ?? fetch)(`${this.base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" }, signal: AbortSignal.timeout(20_000) }), this.name);
  }
  private async ensureIpn(notifyUrl: string) {
    if (this.ipnId) return this.ipnId;
    const body = await this.call("/api/URLSetup/RegisterIPN", { method: "POST", body: JSON.stringify({ url: notifyUrl, ipn_notification_type: "GET" }) });
    if (!body.ipn_id) throw new AppError("INTERNAL", "Pesapal didn't register the notification URL.");
    this.ipnId = String(body.ipn_id);
    return this.ipnId;
  }

  async createCheckout(i: CheckoutInput) {
    const notification_id = await this.ensureIpn(i.notifyUrl);
    const [first, ...rest] = (i.customerName ?? "").split(" ");
    const body = await this.call("/api/Transactions/SubmitOrderRequest", {
      method: "POST",
      body: JSON.stringify({ id: i.reference, currency: i.currency, amount: Number(major(i.amountMinor)), description: i.description.slice(0, 100), callback_url: i.returnUrl, cancellation_url: i.cancelUrl, notification_id, billing_address: { email_address: i.customerEmail, first_name: first || undefined, last_name: rest.join(" ") || undefined } }),
    });
    if (!body.redirect_url || !body.order_tracking_id) throw new AppError("INTERNAL", `Pesapal didn't create the order${body.error ? `: ${JSON.stringify(body.error).slice(0, 160)}` : ""}.`);
    return { redirectUrl: String(body.redirect_url), providerReference: String(body.order_tracking_id) };
  }

  /** Pesapal IPNs are unsigned; they are treated purely as "go and check", and the status is always fetched. */
  async parseNotification(req: IncomingRequest): Promise<NotificationRef> {
    const q = req.method === "GET" ? req.url.searchParams : new URLSearchParams(Object.entries((() => { try { return JSON.parse(req.body) as Record<string, string>; } catch { return {}; } })()));
    const trackingId = q.get("OrderTrackingId");
    const merchantRef = q.get("OrderMerchantReference");
    if (!trackingId || !/^[A-Za-z0-9-]{8,80}$/.test(trackingId)) throw new AppError("VALIDATION", "Missing OrderTrackingId.");
    return { eventId: null, type: q.get("OrderNotificationType") ?? "IPNCHANGE", reference: merchantRef, providerReference: trackingId };
  }

  notificationResponse(ref: NotificationRef) {
    return { status: 200, contentType: "application/json", body: JSON.stringify({ orderNotificationType: ref.type, orderTrackingId: ref.providerReference, orderMerchantReference: ref.reference, status: 200 }) };
  }

  async verify(p: { reference: string; providerReference: string | null }): Promise<VerifiedPayment> {
    if (!p.providerReference) return { status: "pending", amountMinor: null, currency: null, providerReference: null, providerStatus: "no order yet", details: {} };
    const d = await this.call(`/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(p.providerReference)}`);
    if (d.merchant_reference && d.merchant_reference !== p.reference) throw new AppError("INTERNAL", "Pesapal returned a different order.");
    const code = Number(d.status_code);
    const status = code === 1 ? "succeeded" : code === 2 ? "failed" : code === 3 ? "refunded" : "pending";
    return { status, amountMinor: typeof d.amount === "number" ? Math.round(d.amount * 100) : null, currency: d.currency ? String(d.currency).toUpperCase() : null, providerReference: p.providerReference, providerStatus: String(d.payment_status_description ?? code), details: { confirmationCode: d.confirmation_code ?? null, method: d.payment_method ?? null } };
  }

  async refund(p: { details: Record<string, unknown> }, amountMinor: number, _currency: string, reason: string) {
    const code = p.details.confirmationCode;
    if (!code) throw new AppError("VALIDATION", "This Pesapal payment has no confirmation code to refund against.");
    const body = await this.call("/api/Transactions/RefundRequest", { method: "POST", body: JSON.stringify({ confirmation_code: code, amount: major(amountMinor), username: "ResearchMate", remarks: reason.slice(0, 200) }) });
    // Pesapal reviews refund requests; completion shows as REVERSED on the transaction.
    return { status: String(body.status) === "200" ? "pending" : "failed", providerReference: null } as const;
  }

  fromReturn(q: URLSearchParams) {
    return { reference: q.get("OrderMerchantReference"), providerReference: q.get("OrderTrackingId") };
  }
}

// ---------------------------------------------------------------------------
// Stripe (for organizations in Stripe-supported countries)
// ---------------------------------------------------------------------------

export class StripeProvider implements PaymentProvider {
  readonly key = "stripe";
  readonly name = "Stripe";
  readonly methods = "Card";
  constructor(
    private readonly opts: { secretKey: string; webhookSecret: string; currencies: string[]; baseUrl?: string; fetch?: Fetcher; toleranceSeconds?: number },
  ) {}
  get currencies() {
    return this.opts.currencies;
  }
  private get base() {
    return (this.opts.baseUrl ?? "https://api.stripe.com").replace(/\/$/, "");
  }
  private call(path: string, form?: Record<string, string>, idempotencyKey?: string) {
    return (this.opts.fetch ?? fetch)(`${this.base}${path}`, {
      method: form ? "POST" : "GET",
      headers: { authorization: `Bearer ${this.opts.secretKey}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  }

  async createCheckout(i: CheckoutInput) {
    const sep = i.returnUrl.includes("?") ? "&" : "?";
    const body = await json(
      await this.call(
        "/v1/checkout/sessions",
        {
          mode: "payment",
          success_url: `${i.returnUrl}${sep}session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: i.cancelUrl,
          client_reference_id: i.reference,
          customer_email: i.customerEmail,
          "line_items[0][quantity]": "1",
          "line_items[0][price_data][currency]": i.currency.toLowerCase(),
          "line_items[0][price_data][unit_amount]": String(i.amountMinor),
          "line_items[0][price_data][product_data][name]": i.description.slice(0, 200),
          "metadata[reference]": i.reference,
          "payment_intent_data[metadata][reference]": i.reference,
        },
        i.reference,
      ),
      this.name,
    );
    if (!body.url || !body.id) throw new AppError("INTERNAL", "Stripe didn't return a checkout link.");
    return { redirectUrl: String(body.url), providerReference: String(body.id) };
  }

  async parseNotification(req: IncomingRequest): Promise<NotificationRef> {
    const header = req.headers.get("stripe-signature") ?? "";
    const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]).filter((p) => p.length === 2)) as Record<string, string>;
    const sigs = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
    const t = Number(parts.t);
    if (!t || !sigs.length) throw new AppError("FORBIDDEN", "Invalid Stripe signature.");
    if (Math.abs(Date.now() / 1000 - t) > (this.opts.toleranceSeconds ?? 300)) throw new AppError("FORBIDDEN", "Stale Stripe signature.");
    const expected = createHmac("sha256", this.opts.webhookSecret).update(`${t}.${req.body}`).digest("hex");
    if (!sigs.some((s) => safeEq(s, expected))) throw new AppError("FORBIDDEN", "Invalid Stripe signature.");
    const ev = JSON.parse(req.body) as { id: string; type: string; data?: { object?: { id?: string; object?: string; client_reference_id?: string; metadata?: { reference?: string } } } };
    const o = ev.data?.object ?? {};
    return { eventId: ev.id, type: ev.type, reference: o.client_reference_id ?? o.metadata?.reference ?? null, providerReference: o.object === "checkout.session" ? (o.id ?? null) : null };
  }

  notificationResponse() {
    return { status: 200, body: JSON.stringify({ received: true }), contentType: "application/json" };
  }

  async verify(p: { providerReference: string | null }): Promise<VerifiedPayment> {
    if (!p.providerReference) return { status: "pending", amountMinor: null, currency: null, providerReference: null, providerStatus: "no session", details: {} };
    const s = await json(await this.call(`/v1/checkout/sessions/${encodeURIComponent(p.providerReference)}`), this.name);
    const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
    const status = paid && s.status === "complete" ? "succeeded" : s.status === "expired" ? "failed" : "pending";
    return { status, amountMinor: typeof s.amount_total === "number" ? s.amount_total : null, currency: s.currency ? String(s.currency).toUpperCase() : null, providerReference: p.providerReference, providerStatus: `${s.status}/${s.payment_status}`, details: { paymentIntent: s.payment_intent ?? null } };
  }

  async refund(p: { reference: string; details: Record<string, unknown> }, amountMinor: number, _currency: string, reason: string) {
    const pi = p.details.paymentIntent;
    if (!pi) throw new AppError("VALIDATION", "This Stripe payment has no payment intent to refund.");
    const r = await json(await this.call("/v1/refunds", { payment_intent: String(pi), amount: String(amountMinor), "metadata[reason]": reason.slice(0, 200) }, `refund:${p.reference}:${amountMinor}:${Date.now()}`), this.name);
    return { status: r.status === "succeeded" ? "succeeded" : r.status === "failed" || r.status === "canceled" ? "failed" : "pending", providerReference: r.id ? String(r.id) : null } as const;
  }

  fromReturn(q: URLSearchParams) {
    return { reference: null, providerReference: q.get("session_id") };
  }
}

/** Builds the providers that are configured in the environment. */
export function providersFromEnv(env: Record<string, string | undefined>): PaymentProvider[] {
  const list = (v: string | undefined, d: string) => (v ?? d).split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  const out: PaymentProvider[] = [];
  if (env.PAYSTACK_SECRET_KEY) out.push(new PaystackProvider({ secretKey: env.PAYSTACK_SECRET_KEY, currencies: list(env.PAYSTACK_CURRENCIES, "KES,USD"), baseUrl: env.PAYSTACK_BASE_URL }));
  if (env.PESAPAL_CONSUMER_KEY && env.PESAPAL_CONSUMER_SECRET) out.push(new PesapalProvider({ consumerKey: env.PESAPAL_CONSUMER_KEY, consumerSecret: env.PESAPAL_CONSUMER_SECRET, currencies: list(env.PESAPAL_CURRENCIES, "KES,USD"), ipnId: env.PESAPAL_IPN_ID ?? null, baseUrl: env.PESAPAL_BASE_URL }));
  if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) out.push(new StripeProvider({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, currencies: list(env.STRIPE_CURRENCIES, "USD"), baseUrl: env.STRIPE_BASE_URL }));
  // PAYMENT_PROVIDER (optional): the provider offered first at checkout.
  const preferred = (env.PAYMENT_PROVIDER ?? "").trim().toLowerCase();
  if (preferred) out.sort((a, b) => Number(b.key === preferred) - Number(a.key === preferred));
  return out;
}
