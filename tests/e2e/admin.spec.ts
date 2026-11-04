import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { type Browser, expect, type Page, test } from "./base";

/**
 * Platform administration end to end: a guest's enquiry from the contact form
 * through the admin inbox and back; user management; plan assignment and
 * feature overrides; plan editing; and that none of it is reachable by
 * ordinary users.
 */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const password = "a long research passphrase";
// Earlier runs leave their enquiries in the database; unique subjects keep runs apart.
const run = randomUUID().slice(0, 6);
const SUBJECT = `Department plan for 40 students ${run}`;
const HELP_SUBJECT = `Word export question ${run}`;

function mailsTo(to: string): string[] {
  return readFileSync(MAIL_LOG, "utf8").split("──── email").filter((b) => b.includes(`To: ${to}`));
}
function linkIn(block: string | undefined, pattern: RegExp): string {
  const m = block?.replace(/=\r?\n/g, "").match(pattern);
  if (!m) throw new Error(`No link matching ${pattern}`);
  return m[0].replace(/=3D/g, "=");
}

async function signUp(browser: Browser, name: string): Promise<{ page: Page; email: string }> {
  const page = await (await browser.newContext()).newPage();
  const email = `e2e-admin-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/register");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect.poll(() => mailsTo(email).length, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.goto(linkIn(mailsTo(email).at(-1), /https?:\/\/[^\s]+\/verify-email\?token=[A-Za-z0-9_%-]+/));
  await page.getByRole("button", { name: "Verify email" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
  return { page, email };
}

test("platform administration end to end", async ({ browser }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const admin = await signUp(browser, "Ada Admin");
  await sql`update users set is_platform_admin = true where email = ${admin.email}`;
  const member = await signUp(browser, "Rita Researcher");

  // Ordinary users can't see administration at all.
  expect((await member.page.goto("/app/admin"))!.status()).toBe(404);
  expect((await member.page.goto("/app/admin/users"))!.status()).toBe(404);
  await member.page.goto("/app");
  await expect(member.page.getByRole("link", { name: "Administration" })).toHaveCount(0);

  // ---- A guest sends an enquiry from the public contact form.
  const guest = await (await browser.newContext()).newPage();
  const guestEmail = `e2e-guest-${randomUUID().slice(0, 8)}@example.test`;
  await guest.goto("/");
  await guest.getByRole("link", { name: "Contact us" }).first().click();
  await expect(guest.getByRole("heading", { name: "Contact us" })).toBeVisible();
  await guest.getByLabel("Your name").fill("Grace Guest");
  await guest.getByLabel("Email").fill(guestEmail);
  await guest.getByLabel("Topic").selectOption("sales");
  await guest.getByLabel("Subject").fill(SUBJECT);
  await guest.getByLabel("Message").fill("Do you offer a department plan for our 40 MSc students? We'd pay by M-PESA.");
  await guest.getByRole("button", { name: "Send message" }).click();
  await expect(guest.getByRole("status")).toContainText(/Your reference is RM-[A-Z2-9]{6}/);
  const reference = (await guest.getByRole("status").innerText()).match(/RM-[A-Z2-9]{6}/)![0];
  await expect.poll(() => mailsTo(guestEmail).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const guestLink = linkIn(mailsTo(guestEmail).at(-1), /https?:\/\/[^\s]+\/support\/[0-9a-f-]{36}\?t=[A-Za-z0-9_-]+/);

  // ---- The administrator sees it, adds a note, and replies.
  const a = admin.page;
  await a.goto("/app");
  await expect(a.getByRole("link", { name: /Administration/ })).toBeVisible();
  await a.getByRole("link", { name: /Administration/ }).click();
  await expect(a.getByRole("heading", { name: "Overview" })).toBeVisible();
  await a.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: /Enquiries/ }).click();
  await a.getByRole("link", { name: SUBJECT }).click();
  await expect(a.getByText(reference)).toBeVisible();
  await a.getByLabel("Note", { exact: true }).fill("Offer the Institution plan in KES.");
  await a.getByRole("button", { name: "Add note" }).click();
  await expect(a.getByRole("status").filter({ hasText: "Note added" })).toBeVisible();
  await a.getByLabel("Message").fill("Yes, we do. The Institution plan covers up to 50 people and can be paid in KES.");
  await a.getByRole("button", { name: "Send reply" }).click();
  await expect(a.getByRole("status").filter({ hasText: "Reply sent" })).toBeVisible();
  await expect.poll(() => mailsTo(guestEmail).length, { timeout: 15_000 }).toBeGreaterThan(1);
  const replyMail = mailsTo(guestEmail).at(-1)!;
  expect(replyMail).toContain("Institution plan covers");
  expect(replyMail).not.toContain("Offer the Institution plan in KES"); // notes stay internal

  // ---- The guest follows their private link and replies; a forged link fails.
  await guest.goto(guestLink);
  await expect(guest.getByRole("heading", { name: SUBJECT })).toBeVisible();
  await expect(guest.getByText("Institution plan covers")).toBeVisible();
  await expect(guest.getByText("Offer the Institution plan in KES")).toHaveCount(0);
  await guest.getByLabel("Add a reply").fill("Wonderful, please send an invoice.");
  await guest.getByRole("button", { name: "Send reply" }).click();
  await expect(guest.getByRole("status")).toContainText("Sent");
  const forged = guestLink.replace(/t=[^&]+/, "t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  expect((await guest.goto(forged))!.status()).toBe(404);
  await a.reload();
  await expect(a.getByText("Wonderful, please send an invoice.")).toBeVisible();

  // ---- A signed-in user asks for help and gets the reply in the app.
  const m = member.page;
  await m.goto("/app/help");
  await m.getByLabel("Subject").fill(HELP_SUBJECT);
  await m.getByLabel("Message").fill("How do I export chapter 2 with my university's template?");
  await m.getByRole("button", { name: "Send" }).click();
  await expect(m.getByText(/Your reference is RM-/)).toBeVisible();
  const helpUrl = m.url().split("?")[0]!;
  await a.goto("/app/admin/enquiries");
  await a.getByRole("link", { name: HELP_SUBJECT }).click();
  await a.getByLabel("Message").fill("Open the document, choose Export, then Word with your template.");
  await a.getByLabel("Then mark it").selectOption("resolved");
  await a.getByRole("button", { name: "Send reply" }).click();
  await expect(a.getByRole("status").filter({ hasText: "Reply sent" })).toBeVisible();
  await m.goto(helpUrl);
  await expect(m.getByText("choose Export, then Word")).toBeVisible();
  await expect(m.getByText("Resolved")).toBeVisible();
  // Another user can't open it.
  const other = await signUp(browser, "Nosy Neighbour");
  expect((await other.page.goto(helpUrl))!.status()).toBe(404);

  // ---- Users: find the member, assign their workspace a plan with an end date.
  await a.goto("/app/admin/users");
  await a.getByRole("searchbox", { name: "Search" }).fill(member.email);
  await a.getByRole("button", { name: "Apply" }).click();
  await a.getByRole("link", { name: "Rita Researcher" }).click();
  await expect(a.getByRole("heading", { name: "Rita Researcher" })).toBeVisible();
  await a.goto((await a.locator('a[href^="/app/admin/organizations/"]').first().getAttribute("href"))!);
  await a.getByLabel("Plan", { exact: true }).selectOption({ label: "Research Pro" });
  const end = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  await a.locator("#ap-end").fill(end);
  await a.locator("#ap-reason").fill("University pilot");
  await a.getByRole("button", { name: "Assign plan" }).click();
  await expect(a.getByRole("status").filter({ hasText: "Plan assigned" })).toBeVisible();
  await a.reload();
  await expect(a.getByText("assigned by an administrator")).toBeVisible();

  // Feature override: Google Drive on for this workspace only.
  await a.locator("#ov-key").selectOption("integrations.google_drive");
  await a.locator("#ov-val").fill("on");
  await a.locator("#ov-reason").fill("Thesis data lives in Drive");
  await a.getByRole("button", { name: "Save override" }).click();
  await expect(a.getByRole("status").filter({ hasText: "Override saved" })).toBeVisible();

  // The member sees the new plan in their own billing settings.
  await m.goto("/app/settings/billing");
  await expect(m.getByText("Research Pro").first()).toBeVisible();

  // ---- Disable the "nosy" account: they're signed out and can't sign back in.
  await a.goto("/app/admin/users");
  await a.getByRole("searchbox", { name: "Search" }).fill(other.email);
  await a.getByRole("button", { name: "Apply" }).click();
  await a.getByRole("link", { name: "Nosy Neighbour" }).click();
  await a.locator("form").filter({ has: a.getByRole("button", { name: "Disable account" }) }).getByLabel("Reason").fill("Test of disabling");
  await a.getByRole("button", { name: "Disable account" }).click();
  await expect(a.getByRole("status").filter({ hasText: "Account disabled" })).toBeVisible();
  await other.page.goto("/app");
  await expect(other.page).toHaveURL(/\/login/);
  await other.page.getByLabel("Email").fill(other.email);
  await other.page.getByLabel("Password").fill(password);
  await other.page.getByRole("button", { name: "Sign in" }).click();
  await expect(other.page.locator("p[role=alert]")).toContainText(/disabled/i);

  // ---- Plans: change what a plan includes.
  await a.goto("/app/admin/plans");
  await a.getByRole("link", { name: "Research Pro" }).click();
  const projects = a.getByLabel("Active research projects per organization");
  const before = await projects.inputValue();
  await projects.fill("unlimited");
  await a.getByRole("button", { name: "Save features" }).click();
  await expect(a.getByRole("status").filter({ hasText: /change\(s\) saved/ })).toBeVisible();
  await a.reload();
  await expect(a.getByLabel("Active research projects per organization")).toHaveValue("unlimited");
  await a.getByLabel("Active research projects per organization").fill(before);
  await a.getByRole("button", { name: "Save features" }).click();
  await expect(a.getByRole("status").filter({ hasText: /saved|Nothing changed/ })).toBeVisible();

  // ---- Everything above is in the audit log, and the system page renders.
  await a.goto("/app/admin/audit?scope=admin");
  for (const action of ["admin.subscription.assigned", "admin.entitlement.override_set", "admin.user.disabled", "admin.plan.entitlements_changed", "admin.support.replied"]) await expect(a.getByText(action).first()).toBeVisible();
  await a.goto("/app/admin/system");
  await expect(a.getByRole("heading", { name: "Health" })).toBeVisible();
  await expect(a.getByText("not answering")).toHaveCount(0);
  for (const path of ["/app/admin/organizations", "/app/admin/subscriptions", "/app/admin/billing", "/app/admin/plans"]) expect((await a.goto(path))!.status()).toBe(200);

  await sql`update users set status = 'active' where email = ${other.email}`;
  await sql.end();
});
