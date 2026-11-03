import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * One local server imitating the Paystack, Pesapal (v3) and Stripe endpoints
 * our adapters call, with the documented request/response shapes and
 * signatures. Tests "pay" by flipping a transaction's state, then deliver a
 * signed notification exactly as the provider would.
 */
export interface FakeTx {
  provider: "paystack" | "pesapal" | "stripe";
  reference: string;
  providerId: string;
  amountMinor: number;
  currency: string;
  state: "pending" | "paid" | "failed" | "reversed";
  /** What the provider reports as paid (to simulate tampering/mismatch). */
  paidAmountMinor?: number;
  refunds: number[];
}

export interface FakePayments {
  url: string;
  txs: Map<string, FakeTx>;
  byReference: (reference: string) => FakeTx | undefined;
  pay: (reference: string, opts?: { amountMinor?: number }) => void;
  paystackWebhook: (reference: string, event?: string) => { body: string; headers: Record<string, string> };
  stripeWebhook: (reference: string, opts?: { secret?: string; timestamp?: number }) => { body: string; headers: Record<string, string> };
  pesapalIpn: (reference: string) => string;
  calls: string[];
  close: () => Promise<void>;
}

export const PAYSTACK_SECRET = "sk_test_paystack_fake";
export const STRIPE_SECRET = "sk_test_stripe_fake";
export const STRIPE_WEBHOOK_SECRET = "whsec_fake";

export async function startFakePayments(port = 0): Promise<FakePayments> {
  const txs = new Map<string, FakeTx>();
  const calls: string[] = [];
  // Unique across runs (like real provider ids), so a persistent dev database never sees a repeat.
  let seq = Date.now() % 1_000_000_000;
  let pesapalToken = "";
  const byReference = (r: string) => [...txs.values()].find((t) => t.reference === r);
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, "http://x");
    const path = url.pathname;
    calls.push(`${req.method} ${path}`);
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const auth = req.headers.authorization ?? "";

    // ---- Test control (E2E): mark a transaction paid ----
    if (path === "/__control/pay") {
      const t = byReference(url.searchParams.get("reference") ?? "");
      if (!t) return send(404, { error: "no such transaction" });
      t.state = "paid";
      return send(200, { ok: true, providerId: t.providerId, amountMinor: t.amountMinor, currency: t.currency });
    }

    // ---- Paystack ----
    if (path.startsWith("/paystack/")) {
      if (auth !== `Bearer ${PAYSTACK_SECRET}`) return send(401, { status: false, message: "Invalid key" });
      if (path === "/paystack/transaction/initialize") {
        const b = JSON.parse(raw);
        const t: FakeTx = { provider: "paystack", reference: b.reference, providerId: String(++seq), amountMinor: b.amount, currency: b.currency, state: "pending", refunds: [] };
        txs.set(t.providerId, t);
        return send(200, { status: true, message: "Authorization URL created", data: { authorization_url: `https://checkout.paystack.test/${t.providerId}`, access_code: `ac_${t.providerId}`, reference: b.reference } });
      }
      const m = path.match(/^\/paystack\/transaction\/verify\/(.+)$/);
      if (m) {
        const t = byReference(decodeURIComponent(m[1]!));
        if (!t) return send(404, { status: false, message: "Transaction reference not found" });
        const status = t.state === "paid" ? "success" : t.state === "failed" ? "failed" : t.state === "reversed" ? "reversed" : "ongoing";
        return send(200, { status: true, data: { id: Number(t.providerId), status, reference: t.reference, amount: t.paidAmountMinor ?? t.amountMinor, currency: t.currency, channel: "mobile_money" } });
      }
      if (path === "/paystack/refund") {
        const b = JSON.parse(raw);
        const t = byReference(b.transaction);
        if (!t || t.state !== "paid") return send(400, { status: false, message: "Transaction not refundable" });
        t.refunds.push(b.amount);
        return send(200, { status: true, data: { id: ++seq, status: "processed", amount: b.amount } });
      }
    }

    // ---- Pesapal v3 ----
    if (path.startsWith("/pesapal/")) {
      if (path === "/pesapal/api/Auth/RequestToken") {
        const b = JSON.parse(raw);
        if (b.consumer_key !== "ck_fake" || b.consumer_secret !== "cs_fake") return send(200, { token: null, error: { code: "invalid_consumer_key_or_secret_provided" }, status: "500" });
        pesapalToken = `tok_${++seq}`;
        return send(200, { token: pesapalToken, expiryDate: new Date(Date.now() + 5 * 60_000).toISOString(), error: null, status: "200" });
      }
      if (auth !== `Bearer ${pesapalToken}`) return send(401, { error: { code: "unauthorized" } });
      if (path === "/pesapal/api/URLSetup/RegisterIPN") return send(200, { ipn_id: "ipn-fake-1", url: JSON.parse(raw).url, status: "200" });
      if (path === "/pesapal/api/Transactions/SubmitOrderRequest") {
        const b = JSON.parse(raw);
        const t: FakeTx = { provider: "pesapal", reference: b.id, providerId: `ot-${++seq}-abcdef`, amountMinor: Math.round(b.amount * 100), currency: b.currency, state: "pending", refunds: [] };
        txs.set(t.providerId, t);
        return send(200, { order_tracking_id: t.providerId, merchant_reference: b.id, redirect_url: `https://pay.pesapal.test/iframe?OrderTrackingId=${t.providerId}`, error: null, status: "200" });
      }
      if (path === "/pesapal/api/Transactions/GetTransactionStatus") {
        const t = txs.get(url.searchParams.get("orderTrackingId") ?? "");
        if (!t) return send(200, { status_code: 0, payment_status_description: "INVALID", status: "500", error: { code: "invalid" } });
        const code = t.state === "paid" ? 1 : t.state === "failed" ? 2 : t.state === "reversed" ? 3 : 0;
        return send(200, { payment_method: "MpesaKE", amount: (t.paidAmountMinor ?? t.amountMinor) / 100, created_date: new Date().toISOString(), confirmation_code: t.state === "paid" || t.state === "reversed" ? `CONF${t.providerId}` : "", payment_status_description: ["INVALID", "COMPLETED", "FAILED", "REVERSED"][code], description: "", message: "Request processed successfully", payment_account: "2547******89", call_back_url: "", status_code: code, merchant_reference: t.reference, currency: t.currency, error: { error_type: null, code: null, message: null }, status: "200" });
      }
      if (path === "/pesapal/api/Transactions/RefundRequest") {
        const b = JSON.parse(raw);
        const t = [...txs.values()].find((x) => `CONF${x.providerId}` === b.confirmation_code);
        if (!t) return send(200, { status: "500", message: "Refund request failed" });
        t.refunds.push(Math.round(Number(b.amount) * 100));
        return send(200, { status: "200", message: "Refund request successfully" });
      }
    }

    // ---- Stripe ----
    if (path.startsWith("/stripe/")) {
      if (auth !== `Bearer ${STRIPE_SECRET}`) return send(401, { error: { message: "Invalid API Key provided" } });
      const form = new URLSearchParams(raw);
      if (path === "/stripe/v1/checkout/sessions" && req.method === "POST") {
        const t: FakeTx = { provider: "stripe", reference: form.get("client_reference_id")!, providerId: `cs_test_${++seq}`, amountMinor: Number(form.get("line_items[0][price_data][unit_amount]")), currency: form.get("line_items[0][price_data][currency]")!.toUpperCase(), state: "pending", refunds: [] };
        txs.set(t.providerId, t);
        return send(200, { id: t.providerId, object: "checkout.session", url: `https://checkout.stripe.test/c/pay/${t.providerId}`, status: "open", payment_status: "unpaid" });
      }
      const m = path.match(/^\/stripe\/v1\/checkout\/sessions\/(.+)$/);
      if (m) {
        const t = txs.get(m[1]!);
        if (!t) return send(404, { error: { message: "No such checkout.session" } });
        return send(200, { id: t.providerId, object: "checkout.session", status: t.state === "paid" ? "complete" : t.state === "failed" ? "expired" : "open", payment_status: t.state === "paid" ? "paid" : "unpaid", amount_total: t.paidAmountMinor ?? t.amountMinor, currency: t.currency.toLowerCase(), client_reference_id: t.reference, payment_intent: t.state === "paid" ? `pi_${t.providerId}` : null });
      }
      if (path === "/stripe/v1/refunds") {
        const t = [...txs.values()].find((x) => `pi_${x.providerId}` === form.get("payment_intent"));
        if (!t) return send(400, { error: { message: "No such payment_intent" } });
        t.refunds.push(Number(form.get("amount")));
        return send(200, { id: `re_${++seq}`, object: "refund", status: "succeeded", amount: Number(form.get("amount")) });
      }
    }
    send(404, { error: "not found", path });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    txs,
    calls,
    byReference,
    pay: (reference, opts = {}) => {
      const t = byReference(reference);
      if (!t) throw new Error(`no tx ${reference}`);
      t.state = "paid";
      if (opts.amountMinor !== undefined) t.paidAmountMinor = opts.amountMinor;
    },
    paystackWebhook: (reference, event = "charge.success") => {
      const t = byReference(reference)!;
      const body = JSON.stringify({ event, data: { id: Number(t.providerId), reference, status: "success", amount: t.amountMinor, currency: t.currency } });
      return { body, headers: { "x-paystack-signature": createHmac("sha512", PAYSTACK_SECRET).update(body).digest("hex"), "content-type": "application/json" } };
    },
    stripeWebhook: (reference, opts = {}) => {
      const t = byReference(reference)!;
      const body = JSON.stringify({ id: `evt_${t.providerId}`, object: "event", type: "checkout.session.completed", data: { object: { id: t.providerId, object: "checkout.session", client_reference_id: reference, payment_status: "paid" } } });
      const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", opts.secret ?? STRIPE_WEBHOOK_SECRET).update(`${ts}.${body}`).digest("hex");
      return { body, headers: { "stripe-signature": `t=${ts},v1=${sig}`, "content-type": "application/json" } };
    },
    pesapalIpn: (reference) => {
      const t = byReference(reference)!;
      return `?OrderTrackingId=${t.providerId}&OrderMerchantReference=${reference}&OrderNotificationType=IPNCHANGE`;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
