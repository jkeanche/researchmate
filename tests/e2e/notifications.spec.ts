import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "./base";

/**
 * Notifications: a password change produces a security notice (unread badge,
 * list, mark read) and preferences can be changed, with security email locked on.
 */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const email = `e2e-ntf-${randomUUID().slice(0, 8)}@example.test`;
const password = "a long research passphrase";

function latestLink(path: string, to: string): string {
  const blocks = readFileSync(MAIL_LOG, "utf8").split("──── email").filter((b) => b.includes(`To: ${to}`));
  const m = blocks.at(-1)?.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_%-]+`));
  if (!m) throw new Error(`No ${path} email for ${to}`);
  return m[0];
}

test("security notice, unread badge, mark read and preferences", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Your name").fill("Amara Notices");
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

  await page.goto("/app/settings/security");
  await page.getByLabel("Current password").fill(password);
  await page.getByLabel("New password", { exact: true }).fill("an even longer research passphrase");
  await page.getByLabel("Confirm new password").fill("an even longer research passphrase");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByLabel("Current password")).toHaveValue("");

  await page.goto("/app");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByLabel("1 unread")).toBeVisible();
  await nav.getByRole("link", { name: /Notifications/ }).click();
  const item = page.getByRole("listitem").filter({ hasText: "Your password was changed" });
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Mark read" }).click();
  await expect(item.getByRole("button", { name: "Mark read" })).toHaveCount(0);
  await expect(nav.getByLabel("1 unread")).toHaveCount(0);

  await page.getByRole("link", { name: "notification settings" }).click();
  const security = page.getByLabel("Security changes to my account (always emailed): email (always on)");
  await expect(security).toBeChecked();
  await expect(security).toBeDisabled();
  const overdueEmail = page.getByLabel("A task of mine is overdue: email");
  await overdueEmail.uncheck();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Notification settings saved." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("A task of mine is overdue: email")).not.toBeChecked();
});
