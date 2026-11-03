import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "./base";
import postgres from "postgres";

/** Milestone-3 finances: enable → budget → approve → expense workflow → dashboard → report downloads. */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const email = `e2e-fin-${randomUUID().slice(0, 8)}@example.test`;
const password = "a long research passphrase";

function latestLink(path: string, to: string): string {
  const blocks = readFileSync(MAIL_LOG, "utf8").split("──── email").filter((b) => b.includes(`To: ${to}`));
  const m = blocks.at(-1)?.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_%-]+`));
  if (!m) throw new Error(`No ${path} email for ${to}`);
  return m[0];
}

test("optional project finances", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Your name").fill("Akinyi Finance");
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

  // Free plan: the module is offered but not available.
  await page.goto("/app/projects/new");
  await page.getByLabel("Title").fill("Unfunded pilot study");
  await page.getByLabel("Research type").selectOption("independent_research");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Finances" }).click();
  await expect(page.getByText(/Budget management is not included in the Free plan/)).toBeVisible();

  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  await sql`update subscriptions set status = 'canceled' where organization_id = (select o.id from organizations o join users u on u.id = o.owner_user_id where u.email = ${email}) and status = 'active'`;
  await sql`insert into subscriptions (organization_id, plan_id, status) select o.id, p.id, 'active' from organizations o join users u on u.id = o.owner_user_id, plans p where u.email = ${email} and p.key = 'research_pro'`;
  await sql.end();

  await page.reload();
  await page.getByLabel("Reporting currency").fill("KES");
  await page.getByRole("button", { name: "Turn on financial tracking" }).click();
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();

  // Budget: draft → lines → approve.
  await page.getByRole("button", { name: "Create a budget" }).click();
  await page.getByLabel("Fieldwork (KES)").fill("150000");
  await page.getByLabel("Transcription (KES)").fill("100000");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await page.getByRole("button", { name: "Approve this budget" }).click();
  await expect(page.getByText(/Approved:\s*version 1/)).toBeVisible();

  // Expense: draft → submit → approve (self-approval is recorded) → paid.
  await page.getByLabel("Description").fill("Field transport");
  await page.getByLabel("Category", { exact: true }).selectOption("fieldwork");
  await page.getByLabel("Amount", { exact: true }).fill("65000");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("Expense recorded.")).toBeVisible();
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("counts as committed")).toBeVisible();
  await page.getByText("History").click();
  await expect(page.getByText(/approved by the submitter/)).toBeVisible();
  await page.getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByText("counts as actual")).toBeVisible();

  // Dashboard figures.
  await page.reload();
  const actual = page.locator("div", { has: page.getByText("Actual expenditure", { exact: true }) }).last();
  await expect(actual).toContainText("65,000.00");
  await expect(page.locator("div", { has: page.getByText("Budget used", { exact: true }) }).last()).toContainText("26%");

  // Reports download in each format.
  for (const fmt of ["PDF", "XLSX", "CSV"]) {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: `Download Project budget summary as ${fmt}` }).click()]);
    expect(dl.suggestedFilename()).toMatch(new RegExp(`budget-summary-.*\\.${fmt.toLowerCase()}$`));
  }
});
