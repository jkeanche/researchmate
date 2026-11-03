import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "./base";
import postgres from "postgres";

/**
 * Milestone-6 document path: library source → new dissertation from a
 * template → write a section with a citation from the picker → preview shows
 * the formatted citation and reference list → citation audit → PDF export is
 * rendered by the worker, validated and downloadable.
 */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const email = `e2e-doc-${randomUUID().slice(0, 8)}@example.test`;
const password = "a long research passphrase";

function latestLink(path: string, to: string): string {
  const blocks = readFileSync(MAIL_LOG, "utf8").split("──── email").filter((b) => b.includes(`To: ${to}`));
  const m = blocks.at(-1)?.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_%-]+`));
  if (!m) throw new Error(`No ${path} email for ${to}`);
  return m[0];
}

test("write, check and export a dissertation", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/register");
  await page.getByLabel("Your name").fill("Wanjiru Doc");
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
  await page.getByLabel("Title").fill("Mobile money and savings");
  await page.getByLabel("Research type").selectOption("masters_thesis");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Mobile money");
  const projectUrl = page.url();

  await page.goto(`${projectUrl}/literature`);
  await page.getByLabel("Or paste entries").fill("@article{suri2016, title={The long-run poverty and gender impacts of mobile money}, author={Suri, Tavneet and Jack, William}, journal={Science}, volume={354}, pages={1288--1292}, year={2016}}");
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText("Imported 1 reference.")).toBeVisible();

  // New document from the Master's template
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New document" })).toBeVisible();
  await page.getByLabel("Title").fill("Mobile Money and Household Savings in Kenya");
  await page.getByLabel(/Master's dissertation/).check();
  await page.getByLabel("Author").fill("Wanjiru Kamau");
  await page.getByRole("button", { name: "Create document" }).click();
  await expect(page.getByRole("heading", { name: /Mobile Money and Household Savings in Kenya/ })).toBeVisible();
  const docUrl = page.url();

  // Write the declaration and introduction
  await page.getByRole("link", { name: /^Declaration/ }).click();
  await expect(page.getByRole("heading", { name: "Declaration", level: 3 })).toBeVisible();
  await page.getByLabel("Section text").fill("I declare that this dissertation is my own work.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Saved/ })).toBeVisible();

  await page.getByRole("link", { name: /^Introduction/ }).click();
  await expect(page.getByRole("heading", { name: "Introduction", level: 3 })).toBeVisible();
  const editor = page.getByLabel("Section text");
  await editor.fill("Mobile money spread quickly across Kenya ");
  await page.getByLabel("Cite a source").selectOption("suri2016");
  await page.getByLabel("Page").fill("1290");
  await page.getByRole("button", { name: "Insert citation" }).click();
  await editor.press("End");
  await editor.pressSequentially(".");
  await expect(editor).toHaveValue("Mobile money spread quickly across Kenya [@suri2016, p. 1290].");
  await expect(page.getByText("6 words", { exact: true })).toBeVisible();
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status").filter({ hasText: /^Saved/ })).toBeVisible();

  // A comment on the section
  await page.getByLabel("Comment", { exact: true }).fill("Add the 2014 study here too.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("Add the 2014 study here too.")).toBeVisible();

  // Preview: formatted citation and reference list
  await page.getByRole("link", { name: "Preview" }).click();
  await expect(page.getByText("Mobile money spread quickly across Kenya (Suri & Jack, 2016, p. 1290).")).toBeVisible();
  await expect(page.getByText(/Suri, T\., & Jack, W\. \(2016\)\. The long-run poverty/)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Contents" })).toContainText("1 Introduction");

  // Checks and audit
  await page.getByRole("link", { name: "Checks & citations" }).click();
  await expect(page.getByRole("row", { name: /@suri2016/ })).toContainText("Unverified");
  await expect(page.getByText(/Empty: Abstract, Literature Review/)).toBeVisible();

  // Export PDF; the worker renders and validates it
  await page.getByRole("link", { name: "Versions & export" }).click();
  await page.getByRole("button", { name: "Export PDF" }).click();
  await expect(page.getByText("PDF export started.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Download PDF version/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Doesn't meet the specification")).toBeVisible(); // required sections are empty
  await expect(page.getByText(/Page numbering\./)).toBeVisible();
  const href = await page.getByRole("link", { name: /Download PDF version/ }).getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // Specification change creates a new version
  await page.getByRole("link", { name: "Specification" }).click();
  await page.getByLabel("Citation style").selectOption("ieee");
  await page.getByRole("button", { name: "Save specification" }).click();
  await expect(page.getByText("Saved as specification version 2.")).toBeVisible();
  await page.goto(`${docUrl}/preview`);
  await expect(page.getByText("Mobile money spread quickly across Kenya [1, p. 1290].")).toBeVisible();
});
