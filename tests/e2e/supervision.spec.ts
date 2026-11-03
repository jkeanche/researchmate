import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "./base";
import postgres from "postgres";

/**
 * Milestone-7 supervision path with two people in separate browsers:
 * the lead invites a supervisor by email → the supervisor registers from the
 * invitation, verifies, accepts on the dashboard → the lead submits a document
 * → the supervisor comments and requests changes → the lead answers the
 * revision task → the supervisor verifies it and the lead can't self-approve.
 */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const id = randomUUID().slice(0, 8);
const leadEmail = `e2e-lead-${id}@example.test`;
const supEmail = `e2e-sup-${id}@example.test`;
const password = "a long research passphrase";

function mails(to: string) {
  return readFileSync(MAIL_LOG, "utf8").split("──── email").filter((b) => b.includes(`To: ${to}`));
}
function latestLink(path: string, to: string): string {
  const m = mails(to).at(-1)?.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_%-]+`));
  if (!m) throw new Error(`No ${path} email for ${to}`);
  return m[0];
}
const waitForLink = (path: string, to: string) => expect.poll(() => { try { return latestLink(path, to); } catch { return ""; } }, { timeout: 15_000 }).toContain("token=");

async function registerAndSignIn(page: Page, name: string, email: string, prefilled = false) {
  if (!prefilled) {
    await page.goto("/register");
    await page.getByLabel("Email").fill(email);
  } else await expect(page.getByLabel("Email")).toHaveValue(email);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await waitForLink("/verify-email", email);
  await page.goto(latestLink("/verify-email", email));
  await page.getByRole("button", { name: "Verify email" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
}

test("supervisor invitation, review and revision", async ({ browser }) => {
  test.setTimeout(120_000);
  const leadCtx = await browser.newContext();
  const supCtx = await browser.newContext();
  const lead = await leadCtx.newPage();
  const sup = await supCtx.newPage();

  await registerAndSignIn(lead, "Achieng Lead", leadEmail);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  await sql`update subscriptions set status = 'canceled' where organization_id = (select o.id from organizations o join users u on u.id = o.owner_user_id where u.email = ${leadEmail}) and status = 'active'`;
  await sql`insert into subscriptions (organization_id, plan_id, status) select o.id, p.id, 'active' from organizations o join users u on u.id = o.owner_user_id, plans p where u.email = ${leadEmail} and p.key = 'research_pro'`;
  await sql.end();

  await lead.goto("/app/projects/new");
  await lead.getByLabel("Title").fill("Water access and school attendance");
  await lead.getByLabel("Research type").selectOption("masters_thesis");
  await lead.getByRole("button", { name: "Create project" }).click();
  await expect(lead.getByRole("heading", { level: 1 })).toContainText("Water access");
  const projectUrl = lead.url();

  // A short document to submit
  await lead.goto(`${projectUrl}/documents`);
  await lead.getByLabel("Title").fill("Chapter 1 draft");
  await lead.getByLabel(/Custom document/).check();
  await lead.getByRole("button", { name: "Create document" }).click();
  await expect(lead.getByRole("heading", { name: /Chapter 1 draft/ })).toBeVisible();
  await lead.getByRole("link", { name: /^Main Text/ }).click();
  await expect(lead.getByRole("heading", { name: "Main Text", level: 3 })).toBeVisible();
  await lead.getByLabel("Section text").fill("Girls attend school more often when water is close.");
  await lead.getByRole("button", { name: "Save", exact: true }).click();
  await expect(lead.getByRole("status").filter({ hasText: /^Saved/ })).toBeVisible();

  // Invite the supervisor by email
  await lead.goto(`${projectUrl}/team`);
  await lead.getByLabel("Email").fill(supEmail);
  await lead.getByLabel("Message (optional)").fill("Would you supervise this thesis?");
  await lead.getByRole("button", { name: "Send invitation" }).click();
  await expect(lead.getByText(`Invitation sent to ${supEmail}.`)).toBeVisible();
  await expect(lead.getByRole("listitem").filter({ hasText: supEmail })).toContainText("expires");
  await waitForLink("/invite", supEmail);

  // The supervisor opens the link, registers (email prefilled), and accepts on the dashboard
  await sup.goto(latestLink("/invite", supEmail));
  await expect(sup.getByText("Achieng Lead invited you to join")).toBeVisible();
  await expect(sup.getByText("Would you supervise this thesis?")).toBeVisible();
  await sup.getByRole("link", { name: "Create an account" }).click();
  await registerAndSignIn(sup, "Dr Otieno", supEmail, true);
  await expect(sup.getByText(/Achieng Lead invited you to supervise/)).toBeVisible();
  await sup.getByRole("button", { name: "Accept" }).click();
  await expect(sup.getByRole("heading", { level: 1 })).toContainText("Water access");

  // The lead submits; the supervisor sees it waiting
  await lead.goto(`${projectUrl}/team`);
  await expect(lead.getByRole("region", { name: "Supervisors" }).or(lead.locator("section", { hasText: "Supervisors" })).first()).toContainText("Dr Otieno");
  await lead.goto(`${projectUrl}/reviews`);
  await lead.getByLabel("Message").fill("Is the argument clear?");
  await lead.getByRole("button", { name: "Submit for review" }).click();
  await expect(lead.getByText("Waiting for review")).toBeVisible();
  const reviewUrl = lead.url();
  await expect(lead.getByRole("button", { name: "Approve this version" })).toHaveCount(0); // no self-approval

  await sup.goto("/app");
  await expect(sup.getByRole("heading", { name: "Waiting for your review (1)" })).toBeVisible();
  await sup.getByRole("link", { name: "Chapter 1 draft" }).click();
  await expect(sup.getByText("Girls attend school more often when water is close.")).toBeVisible();
  await sup.locator("#fc-sec").selectOption({ label: "Main Text" });
  await sup.getByLabel("Importance").selectOption("major");
  await sup.getByLabel("Passage (optional)").fill("more often");
  await sup.locator("#fc-body").fill("Say by how much, and cite the source.");
  await sup.getByRole("button", { name: "Add comment" }).click();
  await expect(sup.getByText("Comment added.")).toBeVisible();
  await sup.getByLabel("Note to the researcher (optional)").fill("Good start.");
  await sup.getByRole("button", { name: "Request changes" }).click();
  await expect(sup.getByText(/Changes requested by Dr Otieno/)).toBeVisible();

  // The lead answers the revision task
  await lead.goto(reviewUrl);
  await expect(lead.getByText("Say by how much, and cite the source.").first()).toBeVisible();
  await lead.getByLabel("What you changed").fill("Added the 12-point difference with a citation.");
  await lead.getByRole("button", { name: "Send response" }).click();
  await expect(lead.getByText("Added the 12-point difference with a citation.")).toBeVisible();
  await expect(lead.getByText("Addressed", { exact: true })).toBeVisible();
  await expect(lead.getByRole("button", { name: "Verify" })).toHaveCount(0); // only supervisors verify

  // The supervisor verifies it
  await sup.goto(reviewUrl);
  await sup.getByRole("button", { name: "Verify" }).click();
  await expect(sup.getByText("Verified", { exact: true }).first()).toBeVisible();

  await lead.goto(`${projectUrl}/reviews`);
  await expect(lead.getByText("Changes requested", { exact: true }).first()).toBeVisible();
  await expect(lead.getByText(/Revision tasks \(0 open\)/)).toBeVisible();

  await leadCtx.close();
  await supCtx.close();
});
