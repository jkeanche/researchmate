import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Deterministic, non-secret test configuration.
process.env.NODE_ENV = "test";
process.env.APP_URL ??= "http://localhost:3000";
process.env.APP_SECRET ??= "test-app-secret-that-is-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/researchmate_test";
process.env.REDIS_URL ??= "redis://localhost:6379/15";
process.env.LOCAL_STORAGE_ROOT = mkdtempSync(join(tmpdir(), "rm-storage-"));
process.env.STORAGE_DRIVER = "local";
