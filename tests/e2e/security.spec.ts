import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Browser, expect, type Page, test } from "./base";
import postgres from "postgres";

/**
 * Security checks over HTTP (§29, §33 "Security"):
 *  - tenant isolation: another user gets 404 for every resource route and page;
 *  - security headers and session cookie flags;
 *  - server actions refuse cross-site origins (CSRF);
 *  - login rate limiting per email;
 *  - user content is rendered as text (no stored XSS).
 */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const password = "a long research passphrase";

function latestLink(path: string, to: string): string {
  const blocks = readFileSync(MAIL_LOG, "utf8").split("──── email").filter((b) => b.includes(`To: ${to}`));
  const m = blocks.at(-1)?.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_%-]+`));
  if (!m) throw new Error(`No ${path} email for ${to}`);
  return m[0];
}

async function signUp(browser: Browser, name: string): Promise<{ page: Page; email: string }> {
  const page = await (await browser.newContext()).newPage();
  const email = `e2e-sec-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/register");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect.poll(() => { try { return latestLink("/verify-email", email); } catch { return ""; } }, { timeout: 15_000 }).toContain("token=");
  await page.goto(latestLink("/verify-email", email));
  await page.getByRole("button", { name: "Verify email" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
  return { page, email };
}

test("tenant isolation, headers, cookies, CSRF, rate limiting and output encoding", async ({ browser, request }) => {
  const a = await signUp(browser, "Owner A");
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  await sql`update subscriptions set status = 'canceled' where organization_id = (select o.id from organizations o join users u on u.id = o.owner_user_id where u.email = ${a.email}) and status = 'active'`;
  await sql`insert into subscriptions (organization_id, plan_id, status) select o.id, p.id, 'active' from organizations o join users u on u.id = o.owner_user_id, plans p where u.email = ${a.email} and p.key = 'research_pro'`;

  // A creates a project whose title tries to inject markup, and uploads a file.
  const evil = `<img src=x onerror="window.__xss=1">Study`;
  await a.page.goto("/app/projects/new");
  await a.page.getByLabel("Title").fill(evil);
  await a.page.getByLabel("Research type").selectOption("masters_thesis");
  await a.page.getByRole("button", { name: "Create project" }).click();
  await expect(a.page.getByRole("heading", { level: 1 })).toHaveText(evil);
  expect(await a.page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  const projectUrl = new URL(a.page.url()).pathname;
  const projectId = projectUrl.split("/").pop()!;
  await a.page.locator('input[type="file"]').setInputFiles({ name: "secret.txt", mimeType: "text/plain", buffer: Buffer.from("confidential notes") });
  await expect(a.page.getByRole("link", { name: "secret.txt" }).first()).toBeVisible({ timeout: 15_000 });
  const [file] = await sql`select f.id from files f where f.project_id = ${projectId}`;
  const [inv] = await sql`select gen_random_uuid() as id`;
  await sql.end();

  // A can download their own file.
  expect((await a.page.request.get(`/api/files/${file!.id}/download`)).status()).toBe(200);

  // B, in another workspace, gets 404 everywhere — never 403 (which would confirm existence).
  const b = await signUp(browser, "Intruder B");
  for (const path of [
    `/api/files/${file!.id}/download`,
    `/api/projects/${projectId}/references/export?format=bibtex`,
    `/api/projects/${projectId}/finance/reports/budget_summary?format=csv`,
    `/api/projects/${projectId}/toolkit/status-report`,
    `/api/projects/${projectId}/toolkit/deck-progress`,
    `/api/documents/exports/${inv!.id}`,
  ]) {
    const res = await b.page.request.get(path);
    expect([404], `${path} → ${res.status()}`).toContain(res.status());
    expect(await res.text()).not.toContain("confidential notes");
  }
  for (const path of [projectUrl, `${projectUrl}/literature`, `${projectUrl}/toolkit`, `${projectUrl}/finance`, `${projectUrl}/search?q=confidential`]) {
    const res = await b.page.goto(path);
    expect(res!.status(), path).toBe(404);
  }
  // B's own search never reaches A's file text.
  await b.page.goto(`/app/search?q=confidential`);
  await expect(b.page.getByText("Nothing matched")).toBeVisible();

  // Security headers on pages and APIs.
  const page = await request.get("/login");
  const h = page.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["content-security-policy"]).toContain("object-src 'none'");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBeTruthy();
  expect(h["x-powered-by"]).toBeUndefined();

  // Session cookie: HttpOnly and SameSite (Secure is added in production over HTTPS).
  const cookies = await a.page.context().cookies();
  const session = cookies.find((c) => /rm_session/.test(c.name))!;
  expect(session.httpOnly).toBe(true);
  expect(["Lax", "Strict"]).toContain(session.sameSite);

  // CSRF: a server-action POST from another origin is refused by Next.js.
  const csrf = await a.page.request.post("/app/settings/profile", { headers: { Origin: "https://evil.example", "Next-Action": "0".repeat(40), "Content-Type": "text/plain;charset=UTF-8" }, data: "[]" });
  expect(csrf.status()).toBeGreaterThanOrEqual(400);

  // Login is rate limited per email.
  const probe = await (await browser.newContext()).newPage();
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    await probe.goto("/login");
    await probe.getByLabel("Email").fill(a.email);
    await probe.getByLabel("Password").fill(`wrong password ${i}`);
    await probe.getByRole("button", { name: "Sign in" }).click();
    const msg = probe.locator("p[role=alert]");
    await expect(msg).toBeVisible();
    limited = /too many/i.test(await msg.innerText());
  }
  expect(limited).toBe(true);

});

test("metrics require the bearer token and expose operational counts only", async ({ request }) => {
  const token = process.env.METRICS_TOKEN;
  test.skip(!token, "METRICS_TOKEN not set for this run");
  expect((await request.get("/api/metrics")).status()).toBe(401);
  expect((await request.get("/api/metrics", { headers: { Authorization: "Bearer wrong-token-wrong-token-wrong" } })).status()).toBe(401);
  const res = await request.get("/api/metrics", { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/plain");
  const body = await res.text();
  for (const line of ['researchmate_dependency_up{dependency="database"} 1', "researchmate_worker_up 1", 'researchmate_queue_jobs{queue="email",state="waiting"}', "researchmate_users "]) expect(body).toContain(line);
  expect(body).not.toMatch(/@example\.test/); // no personal data
  const health = await (await request.get("/api/health")).json();
  expect(health.checks).toMatchObject({ database: "ok", redis: "ok", storage: "ok", worker: "ok" });
});
