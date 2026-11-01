import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against a running stack (web + worker + Postgres + Redis).
 *   E2E_BASE_URL   default http://localhost:3000
 *   E2E_MAIL_LOG   path of the worker's stdout when no SMTP is configured;
 *                  used to read verification emails.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome",
    headless: true,
    viewport: { width: 1280, height: 860 },
    screenshot: "only-on-failure",
  },
  // Keep artifacts outside the repo: writes inside it trigger dev-server reloads mid-test.
  outputDir: process.env.E2E_OUTPUT_DIR ?? join(tmpdir(), "researchmate-e2e"),
});
