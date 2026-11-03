import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "./base";
import postgres from "postgres";

/**
 * Milestone-2 planning flow on a Research Pro organization:
 * propose schedule → approve → drag a Gantt bar (server cascades successors)
 * → keyboard move → export → baseline → board status → dependency loop refused.
 *
 * The plan upgrade is done in the database (there is no payment flow yet),
 * so DATABASE_URL must point at the stack's database.
 */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const email = `e2e-plan-${randomUUID().slice(0, 8)}@example.test`;
const password = "a long research passphrase";

function latestLink(path: string, to: string): string {
  const blocks = readFileSync(MAIL_LOG, "utf8").split("──── email").filter((b) => b.includes(`To: ${to}`));
  const m = blocks.at(-1)?.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_%-]+`));
  if (!m) throw new Error(`No ${path} email for ${to}`);
  return m[0];
}

test("project planning: proposal, Gantt editing, baseline, board", async ({ page }) => {
  // Register, verify, sign in.
  await page.goto("/register");
  await page.getByLabel("Your name").fill("Otieno Planner");
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

  // Upgrade to Research Pro (admin operation until billing exists).
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  await sql`
    with o as (select o.id from organizations o join users u on u.id = o.owner_user_id where u.email = ${email})
    update subscriptions set status = 'canceled' where organization_id = (select id from o) and status = 'active'`;
  await sql`
    insert into subscriptions (organization_id, plan_id, status)
    select o.id, p.id, 'active' from organizations o join users u on u.id = o.owner_user_id, plans p where u.email = ${email} and p.key = 'research_pro'`;
  await sql.end();

  // Project with the default thesis workflow.
  await page.goto("/app/projects/new");
  await page.getByLabel("Title").fill("Mobile money and household savings in Kisumu");
  await page.getByLabel("Research type").selectOption("masters_thesis");
  await page.getByLabel("Start date").fill("2026-09-01");
  await page.getByLabel("Expected completion").fill("2027-08-31");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Mobile money");
  const projectUrl = page.url();

  await page.getByRole("link", { name: "Workflow" }).click();
  await expect(page.getByRole("heading", { name: "Topic refinement" })).toBeVisible();

  // Proposal → nothing added until approved.
  await page.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Schedule" }).click();
  await page.getByRole("button", { name: "Propose a schedule" }).click();
  await expect(page.getByText("Awaiting review")).toBeVisible();
  await expect(page.getByText(/scaled by/)).toBeVisible();
  await page.getByRole("button", { name: /Add 22 items to the plan/ }).click();
  await expect(page.locator("g.gantt-bar")).toHaveCount(22);

  // Drag "Project setup" (first bar) one week later; its successors follow.
  await page.getByLabel("Zoom").selectOption("day");
  const bar = page.locator("g.gantt-bar").first();
  await bar.scrollIntoViewIfNeeded();
  // The chart opens centred on today; this project started earlier, so scroll to its start.
  await page.locator(".gantt-screen .overflow-x-auto").evaluate((el) => (el.scrollLeft = 0));
  const rect = bar.locator("rect").nth(1); // [0] is the forecast outline when the task is late
  const box = (await rect.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 28 * 7, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole("status").filter({ hasText: "Also moved to keep dependencies valid" })).toBeVisible({ timeout: 10_000 });

  // Keyboard: focus the second bar and move it one day.
  await page.locator("g.gantt-bar").nth(1).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  // Export downloads.
  const [png] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "PNG" }).click()]);
  expect(png.suggestedFilename()).toBe("gantt.png");

  // Baseline.
  await page.getByLabel("Name").fill("Approved plan");
  await page.getByRole("button", { name: "Save baseline" }).click();
  await expect(page.getByText(/Saved “Approved plan”/)).toBeVisible();

  // History on the moved task.
  await page.goto(`${projectUrl}/tasks`);
  await page.getByRole("link", { name: "Project setup" }).click();
  await expect(page.getByText("Moved on the Gantt chart")).toBeVisible();

  // A dependency that would create a loop is refused: setup waits for its own successor.
  await page.getByLabel("This item").selectOption("predecessor");
  await page.getByLabel("Task", { exact: true }).selectOption({ label: "3 Topic refinement" });
  await page.getByRole("button", { name: "Add dependency" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("loop");

  // Board: move a card with the keyboard-friendly status menu.
  await page.goto(`${projectUrl}/tasks?view=board`);
  await page.getByLabel("Move “Project setup” to").selectOption("in_progress");
  await expect(page.getByRole("region", { name: "In progress" }).getByRole("link", { name: "Project setup" })).toBeVisible();
  await expect(page.getByText("Saving…")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(page.getByRole("region", { name: "In progress" }).getByRole("link", { name: "Project setup" })).toBeVisible();
});
