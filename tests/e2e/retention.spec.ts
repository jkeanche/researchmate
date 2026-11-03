import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "./base";

/**
 * Retention: an owner deletes their only workspace, lands on the workspace
 * chooser, restores it; then deletes their account and can no longer sign in.
 */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const email = `e2e-del-${randomUUID().slice(0, 8)}@example.test`;
const password = "a long research passphrase";

function latestLink(path: string, to: string): string {
  const blocks = readFileSync(MAIL_LOG, "utf8").split("──── email").filter((b) => b.includes(`To: ${to}`));
  const m = blocks.at(-1)?.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_%-]+`));
  if (!m) throw new Error(`No ${path} email for ${to}`);
  return m[0];
}

test("delete and restore a workspace, then delete the account", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Your name").fill("Amara Leaving");
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

  await page.goto("/app/settings/organization");
  const name = (await page.locator("label", { hasText: "Type the workspace name" }).innerText()).match(/\((.+)\)/)![1]!;
  await page.getByLabel(/Type the workspace name/).fill("not the name");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Delete workspace" }).click();
  await expect(page.getByText(/exactly to confirm/)).toBeVisible();
  await page.getByLabel(/Type the workspace name/).fill(name);
  await page.getByRole("button", { name: "Delete workspace" }).click();

  await page.waitForURL(/\/workspace$/);
  await expect(page.getByRole("heading", { name: "You don't have a workspace" })).toBeVisible();
  await page.goto("/app"); // the app shell sends a user without a workspace here, without looping
  await page.waitForURL(/\/workspace$/);
  await page.getByRole("button", { name: `Restore ${name}` }).click();
  await page.waitForURL(/\/app\/settings\/organization$/);
  await expect(page.getByLabel(/Type the workspace name/)).toBeVisible();

  await page.goto("/app/settings/profile");
  const del = page.locator("form", { has: page.getByRole("button", { name: "Delete my account" }) });
  await del.getByLabel("Password", { exact: true }).fill(password);
  await del.getByLabel("Type DELETE to confirm").fill("DELETE");
  await del.getByRole("button", { name: "Delete my account" }).click();
  await page.waitForURL(/\/login/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("p[role=alert]")).toContainText(/Incorrect email or password/);
});
