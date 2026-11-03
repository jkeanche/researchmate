import { AiService } from "@researchmate/ai";
import { customerPrice, LedgerService, PaymentService, PaystackProvider, PesapalProvider, StripeProvider, tokenCost } from "@researchmate/billing";
import { aiRuns, creditLedgerEntries, invoices, notifications, payments, plans, pricePoints, pricingItems, pricingVersions, subscriptions, usageRecords } from "@researchmate/database";
import { ProjectService } from "@researchmate/research";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, setPlan, testDb } from "./helpers";
import { type FakePayments, PAYSTACK_SECRET, STRIPE_SECRET, STRIPE_WEBHOOK_SECRET, startFakePayments } from "./support/fake-payments";
import { type MockLlm, startMockLlm } from "./support/mock-llm";

let llm: MockLlm;
let fake: FakePayments;
beforeAll(async () => {
  llm = await startMockLlm();
  fake = await startFakePayments();
});
afterAll(async () => {
  await llm.close();
  await fake.close();
  await closeTestDb();
});

const rejectsWith = (re: RegExp) => (e: unknown) => re.test(String((e as { cause?: Error }).cause?.message ?? (e as Error).message));
const ledger = () => new LedgerService(testDb());
const notices = async (userId: string) => testDb().select().from(notifications).where(eq(notifications.userId, userId));
const pay = () =>
  new PaymentService(testDb(), {
    appUrl: "https://rm.test",
    providers: [
      new PaystackProvider({ secretKey: PAYSTACK_SECRET, currencies: ["KES", "USD"], baseUrl: `${fake.url}/paystack` }),
      new PesapalProvider({ consumerKey: "ck_fake", consumerSecret: "cs_fake", currencies: ["KES"], baseUrl: `${fake.url}/pesapal` }),
      new StripeProvider({ secretKey: STRIPE_SECRET, webhookSecret: STRIPE_WEBHOOK_SECRET, currencies: ["USD"], baseUrl: `${fake.url}/stripe` }),
    ],
  });
const req = (method: string, path: string, body = "", headers: Record<string, string> = {}) => ({ method, url: new URL(`https://rm.test${path}`), headers: new Headers(headers), body });

/** Resets pricing to a single active version with the given model prices (tests share one database). */
async function activePricing(items: unknown[], marginBps = 4000) {
  const l = ledger();
  const v = await l.draftPricing(null as never, { targetMarginBps: marginBps, items });
  await l.activatePricing(v.id);
  return v;
}

async function creditPack(micros: number, currency: string, amountMinor: number) {
  const [pp] = await testDb().insert(pricePoints).values({ kind: "credits", creditMicros: micros, currency, amountMinor, label: `Credit ${micros}` }).returning();
  return pp!;
}

describe("pricing versions", () => {
  it("prices = cost / (1 − margin); active versions are immutable", async () => {
    expect(customerPrice(600_000, 4000)).toBe(1_000_000);
    expect(customerPrice(1, 4000)).toBe(2);
    expect(tokenCost(1_000_000, 500_000, { inputCostMicrosPerMTok: 3_000_000, outputCostMicrosPerMTok: 15_000_000 })).toBe(10_500_000);

    await expect(ledger().draftPricing(null as never, { targetMarginBps: 9600, items: [] })).rejects.toThrow(/margin/);
    await expect(ledger().draftPricing(null as never, { targetMarginBps: 3000, items: [{ kind: "ai_model", providerKey: "openai", modelId: "x", inputCostMicrosPerMTok: -1, outputCostMicrosPerMTok: 0 }] })).rejects.toThrow(/Price line 1/);
    const v = await activePricing([{ kind: "ai_model", providerKey: "openai_compatible", modelId: "platform-model", inputCostMicrosPerMTok: 1_000_000, outputCostMicrosPerMTok: 4_000_000 }]);
    const [item] = await testDb().select().from(pricingItems).where(eq(pricingItems.pricingVersionId, v.id));
    await expect(testDb().update(pricingItems).set({ inputCostMicrosPerMTok: 1 }).where(eq(pricingItems.id, item!.id))).rejects.toSatisfy(rejectsWith(/can no longer change/));
    await expect(testDb().update(pricingVersions).set({ targetMarginBps: 1000 }).where(eq(pricingVersions.id, v.id))).rejects.toSatisfy(rejectsWith(/cannot be changed/));
    const v2 = await activePricing([{ kind: "ai_model", providerKey: "openai_compatible", modelId: "platform-model", inputCostMicrosPerMTok: 2_000_000, outputCostMicrosPerMTok: 8_000_000 }]);
    const both = await testDb().select().from(pricingVersions).where(inArray(pricingVersions.id, [v.id, v2.id]));
    expect(Object.fromEntries(both.map((x) => [x.id === v.id ? "old" : "new", x.status]))).toEqual({ old: "retired", new: "active" });
  });
});

describe("platform-funded AI", () => {
  const platform = () => ({ providerKey: "openai_compatible" as const, modelId: "platform-model", apiKey: "sk-platform-0000", baseUrl: llm.url });
  const ai = (withPlatform = true) => new AiService(testDb(), { enqueue: async () => {}, allowPrivateEndpoints: true, platform: withPlatform ? platform() : null, platformMaxOutputTokens: 1000 });
  async function setup(plan = "research_pro") {
    const u = await createUser("Platform user");
    await setPlan(u.orgId, plan);
    const project = await new ProjectService(testDb()).create(u.userId, u.orgId, { title: "Platform AI", researchType: "custom", workflowTemplateKey: "" });
    return { u, project };
  }

  it("charges the allowance, then credit, at the active price; never for BYOK; caps output", async () => {
    await activePricing([{ kind: "ai_model", providerKey: "openai_compatible", modelId: "platform-model", inputCostMicrosPerMTok: 1_000_000, outputCostMicrosPerMTok: 4_000_000 }]);
    const { u, project } = await setup();
    await expect(ai(false).startRun(u.userId, project.id, "risk-assessment")).rejects.toThrow(/isn't offered.*Add your own AI provider key/);

    const run = await ai().startRun(u.userId, project.id, "risk-assessment");
    expect(run).toMatchObject({ funding: "platform", credentialId: null, modelId: "platform-model" });
    expect(run.estimatedChargeMicros).toBe(customerPrice(tokenCost(12_000, 1000, { inputCostMicrosPerMTok: 1_000_000, outputCostMicrosPerMTok: 4_000_000 }), 4000));
    expect((await ledger().balance(u.orgId)).reservedMicros).toBe(run.estimatedChargeMicros);
    llm.reply(JSON.stringify({ risks: [{ title: "Delay", category: "schedule", likelihood: 2, impact: 2, mitigation: "Buffer", rationale: "Common" }] }));
    await ai().processRun(run.id);
    const sent = llm.requests.at(-1)!;
    expect(sent.headers.authorization).toBe("Bearer sk-platform-0000");
    expect(sent.body.max_tokens).toBe(1000);

    const [done] = await testDb().select().from(aiRuns).where(eq(aiRuns.id, run.id));
    const cost = tokenCost(120, 30, { inputCostMicrosPerMTok: 1_000_000, outputCostMicrosPerMTok: 4_000_000 });
    expect(done).toMatchObject({ status: "succeeded", providerCostMicros: cost, customerChargeMicros: customerPrice(cost, 4000) });
    const entries = await testDb().select().from(creditLedgerEntries).where(eq(creditLedgerEntries.organizationId, u.orgId));
    expect(entries.map((e) => [e.kind, e.pool, e.amountMicros])).toEqual([["usage", "allowance", -customerPrice(cost, 4000)]]);
    const b = await ledger().balance(u.orgId);
    expect(b).toMatchObject({ allowanceMicros: 5_000_000, allowanceUsedMicros: customerPrice(cost, 4000), reservedMicros: 0, creditMicros: 0 });
    // Ledger entries can't be edited or deleted.
    await expect(testDb().update(creditLedgerEntries).set({ amountMicros: 1 }).where(eq(creditLedgerEntries.organizationId, u.orgId))).rejects.toSatisfy(rejectsWith(/append-only/));

    // A chosen key is always BYOK: no charge, even with platform AI available.
    const key = await ai().addCredential(u.userId, u.orgId, { providerKey: "openai_compatible", label: "Mine", apiKey: "sk-user-1111", defaultModel: "platform-model", baseUrl: llm.url });
    const byok = await ai().startRun(u.userId, project.id, "risk-assessment", {}, key.id);
    llm.reply(JSON.stringify({ risks: [] }));
    await ai().processRun(byok.id);
    const [b2] = await testDb().select().from(aiRuns).where(eq(aiRuns.id, byok.id));
    expect(b2).toMatchObject({ funding: "byok", customerChargeMicros: 0, providerCostMicros: cost });
    expect(llm.requests.at(-1)!.headers.authorization).toBe("Bearer sk-user-1111");
    // …and a failing BYOK run stays failed (no platform fallback).
    const failing = await ai().startRun(u.userId, project.id, "risk-assessment", {}, key.id);
    llm.failNext(401, "bad key");
    await ai().processRun(failing.id);
    expect((await testDb().select().from(aiRuns).where(eq(aiRuns.organizationId, u.orgId))).filter((r) => r.funding === "platform")).toHaveLength(1);
  });

  it("enforces available funds, the monthly cap and the per-run cap; not offered on Free", async () => {
    await activePricing([{ kind: "ai_model", providerKey: "openai_compatible", modelId: "platform-model", inputCostMicrosPerMTok: 60_000_000, outputCostMicrosPerMTok: 120_000_000 }]);
    const free = await setup("free");
    await expect(ai().startRun(free.u.userId, free.project.id, "risk-assessment")).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });

    const { u, project } = await setup("starter"); // $1 allowance
    await expect(ai().startRun(u.userId, project.id, "risk-assessment", {}, null, "platform")).rejects.toThrow(/Not enough AI credit/);
    await ledger().addCredit(testDb(), { organizationId: u.orgId, amountMicros: 10_000_000, kind: "adjustment", description: "test top-up", idempotencyKey: `t:${u.orgId}` });
    await ledger().setLimits(u.userId, u.orgId, { monthlyCapMicros: 500_000, perRunCapMicros: null });
    await expect(ai().startRun(u.userId, project.id, "risk-assessment", {}, null, "platform")).rejects.toThrow(/monthly spending limit/);
    await ledger().setLimits(u.userId, u.orgId, { monthlyCapMicros: null, perRunCapMicros: 100_000 });
    await expect(ai().startRun(u.userId, project.id, "risk-assessment", {}, null, "platform")).rejects.toThrow(/per-run limit/);
    await ledger().setLimits(u.userId, u.orgId, { monthlyCapMicros: null, perRunCapMicros: null });
    const run = await ai().startRun(u.userId, project.id, "risk-assessment", {}, null, "platform");
    expect(run.funding).toBe("platform");
    // Money held by a queued run counts against what's left.
    const b = await ledger().balance(u.orgId);
    expect(b.availableMicros).toBe(1_000_000 + 10_000_000 - run.estimatedChargeMicros!);
    // Explicitly asking for BYOK without a key never uses platform credit.
    await expect(ai().startRun(u.userId, project.id, "risk-assessment", {}, null, "byok")).rejects.toThrow(/Add your own AI provider key/);
  });

  it("meters OCR as a separate service, charged only when priced", async () => {
    const { u } = await setup();
    const l = ledger();
    await activePricing([]);
    const unpriced = await l.meterService(testDb(), { organizationId: u.orgId, serviceKey: "ocr.pages", quantity: 4, unit: "page", sourceType: "test", sourceId: crypto.randomUUID() });
    expect(unpriced).toMatchObject({ customerChargeMicros: 0, providerCostMicros: null });
    await activePricing([{ kind: "service", serviceKey: "ocr.pages", unit: "page", unitCostMicros: 1500 }], 5000);
    const priced = await l.meterService(testDb(), { organizationId: u.orgId, serviceKey: "ocr.pages", quantity: 4, unit: "page", sourceType: "test", sourceId: crypto.randomUUID() });
    expect(priced).toMatchObject({ providerCostMicros: 6000, customerChargeMicros: 12_000 });
    const breakdown = await l.usageBreakdown(u.userId, u.orgId);
    expect(breakdown.services).toEqual([expect.objectContaining({ kind: "ocr.pages", quantity: 8, chargeMicros: 12_000 })]);
    expect(breakdown.ai).toEqual([]);
  });
});

describe("payments", () => {
  async function billingOrg() {
    const u = await createUser("Billing owner");
    await setPlan(u.orgId, "starter");
    return u;
  }

  it("Paystack: checkout → signed webhook → server-side verification → credit, invoice; duplicates and forgeries ignored", async () => {
    const u = await billingOrg();
    const pp = await creditPack(25_000_000, "KES", 325_000);
    await expect(pay().checkout(u.userId, u.orgId, { pricePointId: pp.id, provider: "stripe" })).rejects.toThrow(/can't take payments in KES/);
    const { redirectUrl, paymentId } = await pay().checkout(u.userId, u.orgId, { pricePointId: pp.id, provider: "paystack" });
    expect(redirectUrl).toMatch(/^https:\/\/checkout\.paystack\.test\//);
    const [p] = await testDb().select().from(payments).where(eq(payments.id, paymentId));

    // A browser landing on the return URL proves nothing.
    expect((await pay().handleReturn("paystack", new URLSearchParams({ reference: p!.reference })))!.status).toBe("pending");
    expect((await ledger().balance(u.orgId)).creditMicros).toBe(0);

    // A forged webhook is refused.
    const forged = fake.paystackWebhook(p!.reference);
    await expect(pay().handleNotification("paystack", req("POST", "/n", forged.body, { "x-paystack-signature": "00" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A correctly signed webhook for an unpaid transaction grants nothing: status is fetched from Paystack.
    const early = fake.paystackWebhook(p!.reference);
    expect((await pay().handleNotification("paystack", req("POST", "/n", early.body, early.headers))).outcome).toBe("pending");

    fake.pay(p!.reference);
    const hook = fake.paystackWebhook(p!.reference, "charge.success.final");
    expect((await pay().handleNotification("paystack", req("POST", "/n", hook.body, hook.headers))).outcome).toBe("succeeded");
    expect((await pay().handleNotification("paystack", req("POST", "/n", hook.body, hook.headers))).outcome).toBe("duplicate");
    // A redelivered event whose first delivery was interrupted still settles a pending payment.
    const c2 = await pay().checkout(u.userId, u.orgId, { pricePointId: pp.id, provider: "paystack" });
    const [p2] = await testDb().select().from(payments).where(eq(payments.id, c2.paymentId));
    fake.pay(p2!.reference);
    const hook2 = fake.paystackWebhook(p2!.reference, "charge.success");
    const ev2 = (await new PaystackProvider({ secretKey: PAYSTACK_SECRET, currencies: ["KES"] }).parseNotification(req("POST", "/n", hook2.body, hook2.headers))).eventId!;
    await testDb().execute(sql`insert into payment_events (provider, event_id, type) values ('paystack', ${ev2}, 'charge.success')`);
    expect((await pay().handleNotification("paystack", req("POST", "/n", hook2.body, hook2.headers))).outcome).toBe("duplicate");
    expect((await testDb().select().from(payments).where(eq(payments.id, c2.paymentId)))[0]!.status).toBe("succeeded");
    await pay().reconcile(paymentId); // reconciling again is harmless
    expect((await ledger().balance(u.orgId)).creditMicros).toBe(50_000_000);
    const inv = await testDb().select().from(invoices).where(eq(invoices.paymentId, paymentId));
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ currency: "KES", amountMinor: 325_000, kind: "invoice" });
    expect(inv[0]!.number).toMatch(/^RM-\d{4}-\d{6}$/);
    const paid = (await notices(u.userId)).filter((n) => n.kind === "billing.subscription");
    // Two payments succeeded; each gets exactly one receipt despite duplicate webhooks and re-reconciling.
    expect(paid.map((n) => n.title)).toEqual(["Payment received — ResearchMate", "Payment received — ResearchMate"]);
    expect(new Set(paid.map((n) => n.dedupeKey))).toEqual(new Set([`payment:${paymentId}`, `payment:${c2.paymentId}`]));
    expect(paid[0]).toMatchObject({ emailStatus: "pending", link: "/app/settings/billing" });
  });

  it("refuses amount mismatches; Stripe signatures and staleness are checked", async () => {
    const u = await billingOrg();
    const pp = await creditPack(10_000_000, "USD", 1000);
    const { paymentId } = await pay().checkout(u.userId, u.orgId, { pricePointId: pp.id, provider: "stripe" });
    const [p] = await testDb().select().from(payments).where(eq(payments.id, paymentId));
    fake.pay(p!.reference, { amountMinor: 100 }); // provider reports a different amount
    const wh = fake.stripeWebhook(p!.reference, { secret: "whsec_wrong" });
    await expect(pay().handleNotification("stripe", req("POST", "/n", wh.body, wh.headers))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const stale = fake.stripeWebhook(p!.reference, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    await expect(pay().handleNotification("stripe", req("POST", "/n", stale.body, stale.headers))).rejects.toThrow(/Stale/);
    const good = fake.stripeWebhook(p!.reference);
    expect((await pay().handleNotification("stripe", req("POST", "/n", good.body, good.headers))).outcome).toBe("failed");
    const [after] = await testDb().select().from(payments).where(eq(payments.id, paymentId));
    expect(after!.details).toMatchObject({ mismatch: "paid 100 USD" });
    expect((await ledger().balance(u.orgId)).creditMicros).toBe(0);
  });

  it("Pesapal: unsigned IPN only triggers verification; plan periods stack; refunds are limited to unspent credit", async () => {
    const u = await billingOrg();
    const [pro] = await testDb().select().from(plans).where(eq(plans.key, "research_pro"));
    const [planPP] = await testDb().insert(pricePoints).values({ kind: "plan", planId: pro!.id, interval: "month", currency: "KES", amountMinor: 330_000, label: "Pro monthly (KES)" }).returning();
    const first = await pay().checkout(u.userId, u.orgId, { pricePointId: planPP!.id, provider: "pesapal" });
    expect(first.redirectUrl).toMatch(/pay\.pesapal\.test/);
    expect(fake.calls).toContain("POST /pesapal/api/URLSetup/RegisterIPN");
    const [p1] = await testDb().select().from(payments).where(eq(payments.id, first.paymentId));
    // An IPN for an unpaid order changes nothing.
    const ipn = fake.pesapalIpn(p1!.reference);
    const r0 = await pay().handleNotification("pesapal", req("GET", `/api/payments/pesapal/notify${ipn}`));
    expect(r0.outcome).toBe("pending");
    expect(JSON.parse(r0.response.body)).toMatchObject({ orderNotificationType: "IPNCHANGE", orderTrackingId: p1!.providerReference, status: 200 });
    fake.pay(p1!.reference);
    expect((await pay().handleNotification("pesapal", req("GET", `/api/payments/pesapal/notify${ipn}`))).outcome).toBe("succeeded");
    const live1 = await pay().subscription(u.orgId);
    expect(live1!.planKey).toBe("research_pro");
    const end1 = live1!.s.currentPeriodEnd!;
    // Renewing early extends from the current end.
    const second = await pay().checkout(u.userId, u.orgId, { pricePointId: planPP!.id, provider: "pesapal" });
    const [p2] = await testDb().select().from(payments).where(eq(payments.id, second.paymentId));
    fake.pay(p2!.reference);
    await pay().handleReturn("pesapal", new URLSearchParams({ OrderTrackingId: p2!.providerReference!, OrderMerchantReference: p2!.reference }));
    const live2 = await pay().subscription(u.orgId);
    expect(live2!.s.id).toBe(live1!.s.id);
    expect(live2!.s.currentPeriodEnd!.getTime() - end1.getTime()).toBeGreaterThan(27 * 86400000);

    // Credit refund: spent credit can't be refunded.
    const pp = await creditPack(10_000_000, "USD", 1000);
    const c = await pay().checkout(u.userId, u.orgId, { pricePointId: pp.id, provider: "paystack" });
    const [pc] = await testDb().select().from(payments).where(eq(payments.id, c.paymentId));
    fake.pay(pc!.reference);
    await pay().reconcile(pc!.id);
    await ledger().addCredit(testDb(), { organizationId: u.orgId, amountMicros: -7_000_000, kind: "adjustment", description: "simulated spend", idempotencyKey: `spend:${u.orgId}` });
    await expect(pay().refund(u.userId, pc!.id, 1000, "Customer request")).rejects.toThrow(/Only unspent credit/);
    await pay().refund(u.userId, pc!.id, 300, "Customer request");
    expect(fake.byReference(pc!.reference)!.refunds).toEqual([300]);
    const [refunded] = await testDb().select().from(payments).where(eq(payments.id, pc!.id));
    expect(refunded).toMatchObject({ status: "partially_refunded", refundedMinor: 300 });
    expect((await ledger().balance(u.orgId)).creditMicros).toBe(0);
    const notes = await testDb().select().from(invoices).where(and(eq(invoices.paymentId, pc!.id), eq(invoices.kind, "credit_note")));
    expect(notes[0]!.amountMinor).toBe(-300);
  });

  it("renewals: reminder, past due, then back to the default plan without deleting anything", async () => {
    const u = await billingOrg();
    const [pro] = await testDb().select().from(plans).where(eq(plans.key, "research_pro"));
    await testDb().update(subscriptions).set({ status: "canceled" }).where(and(eq(subscriptions.organizationId, u.orgId), eq(subscriptions.status, "active")));
    const now = Date.now();
    const [s] = await testDb().insert(subscriptions).values({ organizationId: u.orgId, planId: pro!.id, status: "active", currentPeriodStart: new Date(now - 25 * 86400000), currentPeriodEnd: new Date(now + 3 * 86400000), provider: "paystack" }).returning();
    const svc = pay();
    expect((await svc.runRenewals()).reminded).toBeGreaterThanOrEqual(1);
    await svc.runRenewals();
    expect((await notices(u.userId)).filter((n) => n.title.includes("renews soon"))).toHaveLength(1); // reminded once per period
    await svc.runRenewals(new Date(now + 4 * 86400000));
    expect((await testDb().select().from(subscriptions).where(eq(subscriptions.id, s!.id)))[0]!.status).toBe("past_due");
    await svc.runRenewals(new Date(now + 7 * 86400000));
    expect((await testDb().select().from(subscriptions).where(eq(subscriptions.id, s!.id)))[0]!.status).toBe("expired");
    expect((await svc.subscription(u.orgId))!.planKey).toBe("free");
    expect((await notices(u.userId)).map((n) => n.title)).toEqual(expect.arrayContaining(["Renew your Research Pro plan", "Your Research Pro plan has ended"]));
    await testDb().execute(sql`select 1`);
    expect(await testDb().select().from(usageRecords).where(eq(usageRecords.organizationId, u.orgId))).toHaveLength(0);
  });
});
