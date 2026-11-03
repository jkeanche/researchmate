import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "./base";
import postgres from "postgres";

/**
 * Milestone-5 literature path: import BibTeX → bibliography in two styles →
 * upload the full text → worker extracts its text → attach and mark reviewed
 * → record evidence under a theme → matrix row → search inside documents →
 * export BibTeX.
 */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const email = `e2e-lit-${randomUUID().slice(0, 8)}@example.test`;
const password = "a long research passphrase";

function latestLink(path: string, to: string): string {
  const blocks = readFileSync(MAIL_LOG, "utf8").split("──── email").filter((b) => b.includes(`To: ${to}`));
  const m = blocks.at(-1)?.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_%-]+`));
  if (!m) throw new Error(`No ${path} email for ${to}`);
  return m[0];
}

test("reference library, evidence and document search", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Your name").fill("Amara Lit");
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
  await page.getByLabel("Title").fill("Mobile money literature review");
  await page.getByLabel("Research type").selectOption("masters_thesis");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Mobile money");
  const projectUrl = page.url();

  // Upload the full text (plain text keeps the fixture small); the worker extracts it.
  const text = "Mobile money adoption increased household savings by 22 percent.\nAttrition was 9 percent and did not differ between arms.";
  await page.locator('input[type="file"]').setInputFiles({ name: "suri2016.txt", mimeType: "text/plain", buffer: Buffer.from(text) });
  await expect(page.getByRole("link", { name: "suri2016.txt" }).first()).toBeVisible({ timeout: 15_000 });

  // Import BibTeX
  await page.getByRole("link", { name: "Literature" }).click();
  await expect(page.getByText("No sources yet")).toBeVisible();
  await page.getByLabel("Or paste entries").fill(
    "@article{suri2016, title={The long-run poverty and gender impacts of mobile money}, author={Suri, Tavneet and Jack, William}, journal={Science}, volume={354}, pages={1288--1292}, year={2016}, doi={10.1126/science.aah5309}}\n" +
      "@article{jack2014, title={Risk sharing and transactions costs: Evidence from Kenya's mobile money revolution}, author={Jack, William and Suri, Tavneet}, journal={American Economic Review}, volume={104}, number={1}, pages={183--223}, year={2014}}",
  );
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText("Imported 2 references.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sources (2)" })).toBeVisible();
  const bib = page.getByRole("list", { name: /Bibliography in APA 7/ });
  await expect(bib).toContainText("Suri, T., & Jack, W. (2016).");
  await page.getByLabel("Style").selectOption("ieee");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("list", { name: /Bibliography in IEEE/ })).toContainText("[1]");

  // Attach the full text and mark it reviewed
  const suri = page.getByRole("listitem").filter({ hasText: "[@suri2016]" });
  await suri.getByText("Manage").click();
  await suri.getByLabel("Project file").selectOption({ label: "suri2016.txt" });
  await suri.getByRole("button", { name: "Attach full text" }).click();
  await expect(suri.getByText("Full text attached").first()).toBeVisible();
  await page.reload();
  const suri2 = page.getByRole("listitem").filter({ hasText: "[@suri2016]" });
  await suri2.getByText("Manage").click();
  await suri2.getByRole("button", { name: "I have read the full text" }).click();
  await expect(suri2.getByText("Full text reviewed")).toBeVisible();

  // Evidence with a theme
  await page.getByRole("link", { name: "Evidence" }).click();
  await page.locator("#theme-name").fill("Savings");
  await page.getByRole("button", { name: "Add theme" }).click();
  await expect(page.getByText("Theme added.")).toBeVisible();
  await page.getByLabel("Quote or passage").fill("Mobile money adoption increased household savings by 22 percent.");
  await page.getByLabel("What it supports").fill("Mobile money raises savings");
  await page.getByLabel("Source").selectOption({ index: 2 });
  await page.getByLabel("Page").fill("1290");
  await page.locator("#ev-themesel").selectOption({ label: "Savings" });
  await page.getByRole("button", { name: "Record evidence" }).click();
  await expect(page.getByText("Evidence recorded.")).toBeVisible();
  await expect(page.getByText("[@suri2016, p. 1290]")).toBeVisible();
  await page.getByRole("button", { name: "Mark checked" }).click();
  await expect(page.getByText("Checked against source")).toBeVisible();

  // Matrix row: a source with only metadata can't claim a full-text basis
  await page.getByRole("link", { name: "Literature matrix" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "[@suri2016]" });
  await row.locator("summary").click();
  await row.getByLabel("Method").fill("Randomised panel");
  await row.getByLabel("Findings").fill("Savings up 22%");
  await expect(row.getByLabel("Written from").locator("option")).toHaveCount(3);
  await row.getByRole("button", { name: "Save row" }).click();
  await expect(page.getByRole("heading", { name: "Matrix (1 of 2 sources)" })).toBeVisible();
  const jack = page.getByRole("listitem").filter({ hasText: "[@jack2014]" });
  await jack.locator("summary").click();
  await expect(jack.getByLabel("Written from").locator("option")).toHaveCount(1);

  // Search inside documents (after the worker has extracted the text)
  await page.getByRole("link", { name: "Search documents" }).click();
  await expect
    .poll(async () => {
      await page.goto(`${projectUrl}/literature/passages?q=attrition`);
      return page.locator("mark").count();
    }, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect(page.locator("mark").first()).toHaveText(/attrition/i);
  await expect(page.getByRole("link", { name: "suri2016.txt" })).toBeVisible();

  // Export BibTeX
  await page.goto(`${projectUrl}/literature`);
  const res = await page.request.get(await page.getByRole("link", { name: "Export library as BibTeX" }).getAttribute("href") as string);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain("@article{suri2016,");
  expect(body).toContain("10.1126/science.aah5309");

  // The search page renders (providers are external, so no query here).
  await page.getByRole("link", { name: "Find sources" }).click();
  await expect(page.getByLabel("Database")).toHaveValue("openalex");

  // Project search finds the reference and the uploaded file's text, with highlighted matches.
  await page.goto(`${projectUrl}/search`);
  await page.getByLabel("Search this project").fill("attrition");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const results = page.getByRole("list", { name: "Search results" });
  await expect(results.getByRole("listitem").filter({ hasText: "File text" }).first()).toContainText("suri2016.txt");
  await expect(results.locator("mark").first()).toHaveText(/attrition/i);
  // Workspace-wide search covers the same project.
  await page.goto(`/app/search?q=${encodeURIComponent("household savings")}`);
  await expect(page.getByRole("list", { name: "Search results" })).toContainText("Mobile money literature review");
});
