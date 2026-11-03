import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "./base";
import postgres from "postgres";

/**
 * Milestone-8 billing path against a local fake of the Paystack API:
 * a platform admin drafts and activates a pricing version → the owner buys
 * AI credit → the browser returns before the payment is made (nothing is
 * granted) → the payment completes → a signed webhook arrives → credit and
 * an invoice appear → a forged webhook is rejected.
 */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const FAKE = "http://127.0.0.1:4010";
const SECRET = "sk_test_paystack_fake";
const email = `e2e-bill-${randomUUID().slice(0, 8)}@example.test`;
const password = "a long research passphrase";

function latestLink(path: string, to: string): string {
  const blocks = readFileSync(MAIL_LOG, "utf8").split("──── email").filter((b) => b.includes(`To: ${to}`));
  const m = blocks.at(-1)?.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_%-]+`));
  if (!m) throw new Error(`No ${path} email for ${to}`);
  return m[0];
}

test("pricing, credit purchase, verified webhook and invoice", async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.goto("/register");
  await page.getByLabel("Your name").fill("Baraka Billing");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect.poll(() => { try { return latestLink("/verify-email", email); } catch { return ""; } }, { timeout: 15_000 }).toContain("token=");
  await page.goto(latestLink("/verify-email", email));
  await page.getByRole("button", { name: "Verify email" }).click();
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  await sql`update users set is_platform_admin = true where email = ${email}`;
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();

  // Platform admin: draft and activate a pricing version
  await page.getByRole("link", { name: "Billing admin" }).click();
  await page.getByLabel("Target margin (%)").fill("40");
  await page.getByLabel("Notes (sources of the costs)").fill("E2E test prices");
  await page.getByLabel("Price lines (JSON)").fill(JSON.stringify([{ kind: "service", serviceKey: "ocr.pages", unit: "page", unitCostMicros: 1200 }]));
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByText(/Draft pricing version \d+ created/)).toBeVisible();
  const draft = page.getByRole("listitem").filter({ hasText: "E2E test prices" }).first();
  await draft.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "E2E test prices" }).first().getByText("active", { exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "E2E test prices" }).first()).toContainText("$0.0020"); // 1,200 µ$ ÷ 0.6

  // Owner buys US$25 of credit with Paystack; the hosted checkout page is simulated.
  await page.route("https://checkout.paystack.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<h1>Paystack checkout (simulated)</h1>" }));
  await page.getByRole("link", { name: "Billing", exact: true }).click();
  await expect(page.getByText("Included this month")).toBeVisible();
  await page.getByLabel(/AI credit \$25\.00/).check();
  await page.getByLabel("Pay with").selectOption("paystack");
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page.getByRole("heading", { name: "Paystack checkout (simulated)" })).toBeVisible();
  const [payment] = await sql`select p.reference from payments p join organizations o on o.id = p.organization_id join users u on u.id = o.owner_user_id where u.email = ${email} order by p.created_at desc limit 1`;
  const reference = payment!.reference as string;

  // Returning before paying grants nothing: the app asks Paystack.
  await page.goto(`/api/payments/paystack/return?reference=${reference}&trxref=${reference}`);
  await expect(page.getByText(/haven't received confirmation from the payment provider/)).toBeVisible();
  await expect(page.getByText("Waiting for payment")).toBeVisible();

  // A forged webhook is rejected.
  const forged = JSON.stringify({ event: "charge.success", data: { id: 1, reference } });
  expect((await request.post("/api/payments/paystack/notify", { data: forged, headers: { "content-type": "application/json", "x-paystack-signature": "deadbeef" } })).status()).toBe(400);

  // The customer pays; Paystack sends a signed webhook; the app verifies with Paystack and credits.
  expect((await request.get(`${FAKE}/__control/pay?reference=${reference}`)).ok()).toBeTruthy();
  const body = JSON.stringify({ event: "charge.success", data: { id: Date.now(), reference } });
  const sig = createHmac("sha512", SECRET).update(body).digest("hex");
  const res = await request.post("/api/payments/paystack/notify", { data: body, headers: { "content-type": "application/json", "x-paystack-signature": sig } });
  expect(res.status()).toBe(200);
  const again = await request.post("/api/payments/paystack/notify", { data: body, headers: { "content-type": "application/json", "x-paystack-signature": sig } });
  expect(again.status()).toBe(200); // duplicate delivery acknowledged, not applied twice

  await page.goto("/app/settings/billing");
  await expect(page.getByText("$25.00").first()).toBeVisible();
  await expect(page.getByText("Paid", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /Invoice RM-/ }).click();
  await expect(page.getByRole("cell", { name: /ResearchMate AI credit \$25\.00/ })).toBeVisible();
  await expect(page.getByText("USD 25.00").first()).toBeVisible();
  const [{ n }] = await sql`select count(*)::int as n from credit_ledger_entries l join organizations o on o.id = l.organization_id join users u on u.id = o.owner_user_id where u.email = ${email}`;
  expect(n).toBe(1);
  await sql.end();
});
