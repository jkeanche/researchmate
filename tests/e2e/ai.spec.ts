import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "./base";
import postgres from "postgres";
import { startMockLlm } from "../support/mock-llm";

/**
 * Milestone-4 AI path end to end: add a BYOK key (pointing at a local
 * OpenAI-compatible mock) → run the risk agent → the worker executes it via
 * the queue → accept a suggestion → it appears in the risk register.
 * Requires ALLOW_PRIVATE_ENDPOINTS=true on the web and worker processes.
 */

const MAIL_LOG = process.env.E2E_MAIL_LOG ?? "/var/tmp/researchmate-mail.log";
const email = `e2e-ai-${randomUUID().slice(0, 8)}@example.test`;
const password = "a long research passphrase";

function latestLink(path: string, to: string): string {
  const blocks = readFileSync(MAIL_LOG, "utf8").split("──── email").filter((b) => b.includes(`To: ${to}`));
  const m = blocks.at(-1)?.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_%-]+`));
  if (!m) throw new Error(`No ${path} email for ${to}`);
  return m[0];
}

test("AI agents with your own key", async ({ page }) => {
  const llm = await startMockLlm();
  try {
    await page.goto("/register");
    await page.getByLabel("Your name").fill("Njeri AI");
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
    await page.getByLabel("Title").fill("Solar irrigation adoption");
    await page.getByLabel("Research type").selectOption("masters_thesis");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Solar irrigation");
    const projectUrl = page.url();

    // Without a key the assistant explains what to do.
    await page.goto(`${projectUrl}/assistant`);
    await expect(page.getByText(/use your own provider key/)).toBeVisible();

    // Add a key (OpenAI-compatible endpoint = the local mock) and test it.
    await page.goto("/app/settings/ai");
    await page.getByLabel("Provider").selectOption("openai_compatible");
    await page.getByLabel("Name").fill("Mock model");
    await page.getByLabel("API key").fill("sk-e2e-secret-9876");
    await page.getByLabel("Model").fill("mock-model");
    await page.getByLabel("Base URL").fill(llm.url);
    await page.getByRole("button", { name: "Save key" }).click();
    await expect(page.getByText("…9876")).toBeVisible();
    await expect(page.getByText("sk-e2e-secret-9876")).toHaveCount(0);
    llm.reply("OK");
    await page.getByRole("button", { name: "Test" }).click();
    await expect(page.getByText("The key works.")).toBeVisible();

    // Run the risk agent through the queue and worker.
    llm.reply(JSON.stringify({ risks: [{ title: "Pump theft in the field", category: "technical", likelihood: 3, impact: 4, mitigation: "Lockable housings", rationale: "Reported in similar studies" }] }));
    await page.goto(`${projectUrl}/assistant`);
    await page.locator("div", { has: page.getByRole("heading", { name: "Risk Assessment Agent" }) }).last().getByRole("button", { name: "Run" }).click();
    await expect(page.getByText("Pump theft in the field")).toBeVisible({ timeout: 20_000 });
    expect(llm.requests.at(-1)!.headers.authorization).toBe("Bearer sk-e2e-secret-9876");
    await expect(page.getByText(/tokens on your own key/)).toBeVisible();

    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("accepted")).toBeVisible();
    await page.goto(`${projectUrl}/risks`);
    await expect(page.getByRole("heading", { name: "Pump theft in the field" })).toBeVisible();
  } finally {
    await llm.close();
  }
});
