import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { Readable } from "node:stream";
import { CreateBucketCommand, ListObjectsV2Command, ListMultipartUploadsCommand, S3Client } from "@aws-sdk/client-s3";
import { getUsage } from "@researchmate/entitlements";
import { FileService, purgeDeletedFiles, S3StorageDriver, UploadTooLargeError } from "@researchmate/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, pdfBuffer, setPlan, streamOf, testDb } from "./helpers";

/**
 * S3 driver tests against a real S3-protocol server.
 *
 * Uses TEST_S3_ENDPOINT when set (e.g. a MinIO container); otherwise starts
 * moto's S3 server locally if `moto_server` is installed
 * (pip install "moto[server]"). Skipped, loudly, when neither is available.
 */
const external = process.env.TEST_S3_ENDPOINT;
const hasMoto = !external && spawnSync("sh", ["-c", "command -v moto_server"]).status === 0;
const enabled = Boolean(external || hasMoto);
if (!enabled) console.warn("[s3-storage] SKIPPED: set TEST_S3_ENDPOINT or install moto_server to run S3 driver tests.");

const BUCKET = "researchmate-test";
const MB = 1024 * 1024;
let proc: ChildProcess | undefined;
let endpoint = external ?? "";
let driver: S3StorageDriver;
let raw: S3Client;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

async function collect(r: Readable) {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Yields `total` bytes in 1 MB chunks without holding them all in memory. */
async function* bigStream(total: number) {
  const chunk = Buffer.alloc(MB, 0x41);
  for (let sent = 0; sent < total; sent += MB) yield chunk.subarray(0, Math.min(MB, total - sent));
}

describe.skipIf(!enabled)("S3-compatible storage driver", () => {
  beforeAll(async () => {
    if (!external) {
      const port = await freePort();
      endpoint = `http://127.0.0.1:${port}`;
      proc = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
      for (let i = 0; i < 50; i++) {
        try {
          await fetch(endpoint);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
    const cfg = {
      bucket: BUCKET,
      region: "us-east-1",
      endpoint,
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "test",
      forcePathStyle: true,
      keyPrefix: "ci",
    };
    raw = new S3Client({ region: cfg.region, endpoint, forcePathStyle: true, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
    await raw.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => {});
    driver = new S3StorageDriver(cfg);
  }, 30_000);

  afterAll(async () => {
    driver?.destroy();
    raw?.destroy();
    proc?.kill();
    await closeTestDb();
  });

  it("passes the health check", async () => {
    await expect(driver.healthCheck()).resolves.toBeUndefined();
  });

  it("round-trips an object with checksum, size and head bytes, under the key prefix", async () => {
    const buf = pdfBuffer(300_000);
    const r = await driver.put("org/a/file1", streamOf(buf), { maxBytes: MB });
    expect(r.sizeBytes).toBe(buf.length);
    expect(r.head.subarray(0, 5).toString()).toBe("%PDF-");
    expect(r.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await driver.exists("org/a/file1")).toBe(true);
    expect((await collect(await driver.get("org/a/file1"))).equals(buf)).toBe(true);
    const listed = await raw.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "ci/org/a/" }));
    expect(listed.Contents?.map((c) => c.Key)).toEqual(["ci/org/a/file1"]);
  });

  it("streams multipart uploads larger than one part", async () => {
    const total = 17 * MB + 123; // three 8 MB parts
    const r = await driver.put("org/a/big", bigStream(total), { maxBytes: 20 * MB });
    expect(r.sizeBytes).toBe(total);
    const got = await collect(await driver.get("org/a/big"));
    expect(got.length).toBe(total);
  }, 60_000);

  it("aborts oversized uploads and leaves no object or open multipart upload behind", async () => {
    await expect(driver.put("org/a/too-big", bigStream(10 * MB), { maxBytes: 9 * MB })).rejects.toBeInstanceOf(UploadTooLargeError);
    expect(await driver.exists("org/a/too-big")).toBe(false);
    const mp = await raw.send(new ListMultipartUploadsCommand({ Bucket: BUCKET, Prefix: "ci/org/a/too-big" }));
    expect(mp.Uploads ?? []).toHaveLength(0);
    // Small (single-PUT) oversize as well.
    await expect(driver.put("org/a/small-big", streamOf(Buffer.alloc(2000)), { maxBytes: 1000 })).rejects.toBeInstanceOf(UploadTooLargeError);
    expect(await driver.exists("org/a/small-big")).toBe(false);
  }, 60_000);

  it("delete is idempotent and exists() reports missing keys", async () => {
    await driver.put("org/a/tmp", streamOf(Buffer.from("x")), { maxBytes: 10 });
    await driver.delete("org/a/tmp");
    await driver.delete("org/a/tmp");
    expect(await driver.exists("org/a/tmp")).toBe(false);
  });

  it("rejects traversal and malformed keys", async () => {
    for (const k of ["../x", "a//b", "/abs", "a/../b", ""]) {
      await expect(driver.put(k, streamOf(Buffer.from("x")), { maxBytes: 10 })).rejects.toThrow(/Invalid storage key/);
    }
  });

  it("FileService on S3: upload, quota, download, delete and purge", async () => {
    const u = await createUser();
    await setPlan(u.orgId, "starter");
    const svc = new FileService({ db: testDb(), driver, maxUploadBytes: 50 * MB });
    const buf = pdfBuffer(400_000);
    const file = await svc.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "paper.pdf", declaredSize: buf.length, body: streamOf(buf) });
    const dl = await svc.openForDownload(u.userId, file.id);
    expect((await collect(dl.stream as Readable)).equals(buf)).toBe(true);
    expect(await driver.exists(dl.version.storageKey)).toBe(true);
    expect((await getUsage(testDb(), u.orgId)).storageBytes).toBe(buf.length);

    // Over the per-file limit (Starter: 20 MB) is refused before bytes are stored.
    await expect(
      svc.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "big.pdf", declaredSize: 21 * MB, body: Readable.from(bigStream(21 * MB)) }),
    ).rejects.toThrow(/at most 20 MB/);

    await svc.delete(u.userId, file.id);
    expect((await getUsage(testDb(), u.orgId)).storageBytes).toBe(0);
    // Retention 0 hours: purge now erases the bytes from the bucket.
    await purgeDeletedFiles(testDb(), driver, 0);
    expect(await driver.exists(dl.version.storageKey)).toBe(false);
  }, 60_000);
});
