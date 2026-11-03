import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "./base";
import postgres from "postgres";

/**
 * Milestone-10 toolkit path: upload CSV → import dataset → mark a missing code
 * → descriptives and a regression → conceptual-framework diagram rendered with
 * Mermaid and saved → questionnaire with a Likert item → codebook download →
 * progress deck download.
 */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const email = `e2e-tk-${randomUUID().slice(0, 8)}@example.test`;
const password = "a long research passphrase";

function latestLink(path: string, to: string): string {
  const blocks = readFileSync(MAIL_LOG, "utf8").split("──── email").filter((b) => b.includes(`To: ${to}`));
  const m = blocks.at(-1)?.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_%-]+`));
  if (!m) throw new Error(`No ${path} email for ${to}`);
  return m[0];
}

test("datasets, analyses, diagrams, questionnaires and generated outputs", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Your name").fill("Amara Toolkit");
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

  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  await sql`update subscriptions set status = 'canceled' where organization_id = (select o.id from organizations o join users u on u.id = o.owner_user_id where u.email = ${email}) and status = 'active'`;
  await sql`insert into subscriptions (organization_id, plan_id, status) select o.id, p.id, 'active' from organizations o join users u on u.id = o.owner_user_id, plans p where u.email = ${email} and p.key = 'research_pro'`;
  await sql.end();

  await page.goto("/app/projects/new");
  await page.getByLabel("Title").fill("Household savings analysis");
  await page.getByLabel("Research type").selectOption("masters_thesis");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Household savings");

  const rows = ["respondent,income,savings,setting", "1,1200,150,urban", "2,980,90,rural", "3,-99,60,rural", "4,1500,210,urban", "5,1100,120,urban", "6,870,70,rural"];
  await page.locator('input[type="file"]').setInputFiles({ name: "savings.csv", mimeType: "text/csv", buffer: Buffer.from(rows.join("\n")) });
  await expect(page.getByRole("link", { name: "savings.csv" }).first()).toBeVisible({ timeout: 15_000 });

  // Import
  await page.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Toolkit" }).click();
  await expect(page.getByText("No datasets yet")).toBeVisible();
  await page.getByLabel("File").selectOption({ label: "savings.csv" });
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText("6 rows · 4 variables")).toBeVisible();

  // Mark -99 as missing on income
  const incomeRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "income", exact: true }) });
  await incomeRow.getByText("Edit").click();
  await incomeRow.getByLabel("Missing-value codes (comma-separated)").fill("-99");
  await incomeRow.getByRole("button", { name: "Save variable" }).click();
  await expect(page.getByText("Cleaning steps (1)")).toBeVisible();
  await expect(incomeRow.getByRole("cell").nth(3)).toHaveText("1");

  // Descriptives
  await page.getByLabel("Numeric variables (select one or more)").selectOption(["income", "savings"]);
  await page.getByRole("button", { name: "Run and save" }).click();
  const desc = page.getByRole("listitem").filter({ hasText: "Descriptive statistics" });
  await expect(desc.getByRole("row").filter({ hasText: "savings" })).toContainText("116.667");
  await expect(desc.getByRole("row").filter({ hasText: "income" })).toContainText("1130");

  // Regression of savings on income and setting
  await page.getByLabel("Analysis").selectOption("regression");
  await page.getByLabel("Outcome (numeric)").selectOption("savings");
  await page.getByLabel(/Predictors/).selectOption(["income", "setting"]);
  await page.getByRole("button", { name: "Run and save" }).click();
  const reg = page.getByRole("listitem").filter({ hasText: "Linear regression" });
  await expect(reg).toContainText("n = 5");
  await expect(reg.getByRole("row").filter({ hasText: "(Intercept)" })).toBeVisible();
  await reg.getByText("Method and assumptions").click();
  await expect(reg).toContainText(/least squares/i);

  // Diagram
  await page.getByRole("navigation", { name: "Toolkit" }).getByRole("link", { name: "Diagrams" }).click();
  await page.waitForURL(/toolkit\/diagrams$/);
  await page.getByLabel("Type").selectOption("conceptual");
  await page.getByRole("button", { name: "Create diagram" }).click();
  await page.waitForURL(/diagrams\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("diagram-render").locator("svg")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Mermaid source").fill("flowchart LR\n  MM[Mobile money use] --> S[Household savings]\n  E[Education] -.-> S");
  await expect(page.getByTestId("diagram-render")).toContainText("Household savings", { timeout: 10_000 });
  await page.getByLabel("Title", { exact: true }).fill("Savings framework");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  const svgDl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download SVG" }).click();
  expect((await svgDl).suggestedFilename()).toBe("savings-framework.svg");
  // Strict security: a click-handler directive is not turned into a script.
  await page.getByLabel("Mermaid source").fill("flowchart LR\n  A[Start] --> B[End]\n  click A call alert(1)");
  await expect(page.getByTestId("diagram-render")).toContainText("Start", { timeout: 10_000 });
  expect(await page.getByTestId("diagram-render").evaluate((el) => el.innerHTML.includes("onclick") || el.querySelector("script") !== null)).toBe(false);

  // Questionnaire
  await page.getByRole("navigation", { name: "Toolkit" }).getByRole("link", { name: "Questionnaires" }).click();
  await page.waitForURL(/toolkit\/surveys$/);
  await page.getByLabel("Title").fill("Household savings survey");
  await page.getByRole("button", { name: "Create questionnaire" }).click();
  await page.waitForURL(/surveys\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Likert scale" }).click();
  await page.getByLabel("Question", { exact: true }).fill("I trust mobile money providers.");
  await page.getByRole("button", { name: "Single choice" }).click();
  const q2 = page.getByRole("listitem", { name: "Question 2" });
  await q2.getByLabel("Question", { exact: true }).fill("Where do you live?");
  await q2.getByLabel("Options (one per line)").fill("Urban\nRural");
  await page.getByRole("button", { name: "Save questionnaire" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  const cbDl = page.waitForEvent("download");
  await page.getByRole("link", { name: /codebook/i }).click();
  expect((await cbDl).suggestedFilename()).toBe("household-savings-survey-codebook.xlsx");

  // Sample size (Cochran, with finite population correction)
  await page.getByRole("navigation", { name: "Toolkit" }).getByRole("link", { name: "Sample size" }).click();
  await page.waitForURL(/toolkit\/sample-size$/);
  await page.getByLabel("Population size (optional)").fill("1000");
  await page.getByRole("button", { name: "Calculate" }).first().click();
  await expect(page.getByText("Required sample: 278")).toBeVisible();
  await expect(page.getByText("n = n₀ / (1 + (n₀ − 1) / N)", { exact: false })).toBeVisible();

  // Generated deck
  await page.getByRole("navigation", { name: "Toolkit" }).getByRole("link", { name: "Presentations and reports" }).click();
  await page.waitForURL(/toolkit\/outputs$/);
  const deck = page.waitForEvent("download");
  await page.getByRole("link", { name: "Progress update (.pptx)" }).click();
  expect((await deck).suggestedFilename()).toBe("household-savings-analysis-progress.pptx");
});
