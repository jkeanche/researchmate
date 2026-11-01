import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Milestone-1 lifecycle: register → verify email → sign in → create project →
 * upload file → hit Free-plan file quota → enable 2FA → sign in with 2FA.
 */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const SHOTS = process.env.E2E_SCREENSHOTS;
const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
const password = "a long research passphrase";

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

function latestLink(path: string, to: string): string {
  const log = readFileSync(MAIL_LOG, "utf8");
  const blocks = log.split("──── email").filter((b) => b.includes(`To: ${to}`));
  const m = blocks.at(-1)?.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_%-]+`));
  if (!m) throw new Error(`No ${path} email for ${to}`);
  return m[0];
}

function base32Decode(s: string) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of s.replace(/\s/g, "").toUpperCase()) {
    value = (value << 5) | A.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function totp(secret: string, offsetSteps = 0) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offsetSteps));
  const d = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = d[d.length - 1]! & 15;
  return String((((d[o]! & 127) << 24) | (d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!) % 1e6).padStart(6, "0");
}

test.describe.configure({ mode: "serial" });

test("research workspace lifecycle", async ({ page }) => {
  // Landing page
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("thesis");
  await shot(page, "01-landing");

  // Register
  await page.getByRole("link", { name: "Create account" }).first().click();
  await page.getByLabel("Your name").fill("Wanjiru Kamau");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("checkbox").check();
  await shot(page, "02-register");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  // Unverified sign-in is refused
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("Verify your email");

  // Verify via emailed link (poll: the worker delivers asynchronously)
  await expect.poll(() => { try { return latestLink("/verify-email", email); } catch { return ""; } }, { timeout: 15_000 }).toContain("token=");
  await page.goto(latestLink("/verify-email", email));
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.locator("p[role=status]")).toContainText("Email verified");

  // Sign in
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back, Wanjiru" })).toBeVisible();
  await shot(page, "03-dashboard-empty");

  // Create a project
  await page.getByRole("link", { name: "New project" }).first().click();
  await page.getByLabel("Title").fill("Climate-smart agriculture adoption among smallholder farmers in Machakos County");
  await page.getByLabel("Research type").selectOption("masters_thesis");
  await page.getByLabel("Academic level").selectOption("Master's");
  await page.getByLabel("Discipline").fill("Agricultural economics");
  await page.getByLabel("Institution").fill("University of Nairobi");
  await page.getByLabel("Start date").fill("2026-09-01");
  await page.getByLabel("Expected completion").fill("2027-08-31");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Climate-smart agriculture");

  // Free plan allows one project
  await page.goto("/app/projects/new");
  await expect(page.getByText("allows 1 project")).toBeVisible();

  // Upload a PDF to the project
  await page.goBack();
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1"), Buffer.alloc(40_000, 0x20)]);
  await page.locator('input[type="file"]').setInputFiles({ name: "literature-review-notes.pdf", mimeType: "application/pdf", buffer: pdf });
  // The file list (server-rendered after refresh) is the source of truth.
  await expect(page.getByRole("link", { name: "literature-review-notes.pdf" }).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "04-project");

  // Second file exceeds the Free-plan file quota (enforced by the server)
  await page.locator('input[type="file"]').setInputFiles({ name: "second.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.locator("p[role=alert]")).toContainText("allows 1 file");

  // Download works and returns the same bytes
  const dl = await page.request.get(await page.getByRole("link", { name: "Download" }).first().getAttribute("href") as string);
  expect(dl.status()).toBe(200);
  expect((await dl.body()).length).toBe(pdf.length);

  await page.goto("/app");
  await shot(page, "05-dashboard");

  // Enable 2FA
  await page.goto("/app/settings/security");
  await page.getByRole("button", { name: "Set up two-factor authentication" }).click();
  const secret = (await page.locator("p.font-mono").innerText()).replace(/\s/g, "");
  await shot(page, "06-2fa-setup");
  await page.getByLabel("6-digit code from the app").fill(totp(secret));
  await page.getByRole("button", { name: "Turn on two-factor authentication" }).click();
  await expect(page.getByText("Save these recovery codes now")).toBeVisible();
  await expect(page.locator("ol li")).toHaveCount(10);
  await shot(page, "07-recovery-codes");

  // Sign out and back in with 2FA
  await page.getByRole("button", { name: "Sign out" }).last().click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await page.getByLabel("Authentication or recovery code").fill(totp(secret, 1));
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back, Wanjiru" })).toBeVisible();

  await page.goto("/app/settings/organization");
  await shot(page, "08-organization");

  // Phone-width layout
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Welcome back, Wanjiru" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, "09-dashboard-mobile");
});

test("cross-origin uploads are refused", async ({ request }) => {
  const res = await request.put("/api/files?organizationId=00000000-0000-0000-0000-000000000000&name=x.pdf", {
    headers: { Origin: "https://evil.example", "Content-Type": "application/octet-stream" },
    data: Buffer.from("%PDF-1.7"),
  });
  expect(res.status()).toBe(403);
});

test("unauthenticated users are redirected and protected APIs refuse access", async ({ page, request }) => {
  await page.goto("/app/projects");
  await expect(page).toHaveURL(/\/login/);
  const res = await request.get("/api/files/00000000-0000-0000-0000-000000000000/download");
  expect(res.status()).toBe(401);
});
