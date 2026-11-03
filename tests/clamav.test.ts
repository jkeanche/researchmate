import { createServer, type Server } from "node:net";
import { getUsage } from "@researchmate/entitlements";
import { ClamAvScanner, FileService, LocalStorageDriver } from "@researchmate/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, setPlan, streamOf, testDb } from "./helpers";

/**
 * A fake clamd speaking the INSTREAM protocol. It flags any stream containing
 * MARKER (a harmless stand-in for a signature; the real EICAR string would be
 * quarantined by antivirus on developer machines).
 */
const MARKER = "RM-TEST-MALWARE-MARKER";
let server: Server;
let port = 0;
const received: number[] = [];

beforeAll(async () => {
  server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let header = false;
    const body: Buffer[] = [];
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!header) {
        const z = buf.indexOf(0);
        if (z < 0) return;
        if (buf.subarray(0, z).toString() !== "zINSTREAM") return void sock.end("UNKNOWN COMMAND\0");
        header = true;
        buf = buf.subarray(z + 1);
      }
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (n === 0) {
          const all = Buffer.concat(body);
          received.push(all.length);
          return void sock.end(all.includes(MARKER) ? "stream: Rm.Test.Marker FOUND\0" : "stream: OK\0");
        }
        if (buf.length < 4 + n) return;
        body.push(buf.subarray(4, 4 + n));
        buf = buf.subarray(4 + n);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.close();
  await closeTestDb();
});

const svc = (p: number) => {
  const driver = new LocalStorageDriver(process.env.LOCAL_STORAGE_ROOT!);
  return { driver, files: new FileService({ db: testDb(), driver, maxUploadBytes: 10e6, scanner: new ClamAvScanner({ host: "127.0.0.1", port: p, timeoutMs: 3000, maxChunk: 1000 }) }) };
};

describe("malware scanning", () => {
  it("scans every upload in chunks; clean files are stored", async () => {
    const u = await createUser("Uploader");
    await setPlan(u.orgId, "research_pro");
    const body = Buffer.alloc(5000, "a");
    const f = await svc(port).files.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "clean.txt", declaredSize: body.length, body: streamOf(body) });
    expect(f.id).toBeTruthy();
    expect(received.at(-1)).toBe(5000); // the whole file reached the scanner, split into 1000-byte chunks
  });

  it("refuses an infected file, removes the object and returns the quota", async () => {
    const u = await createUser("Uploader");
    await setPlan(u.orgId, "research_pro");
    const before = await getUsage(testDb(), u.orgId);
    const body = Buffer.from(`notes ${MARKER} more`);
    await expect(svc(port).files.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "bad.txt", declaredSize: body.length, body: streamOf(body) })).rejects.toThrow(/flagged by the malware scanner/);
    const after = await getUsage(testDb(), u.orgId);
    expect(after.files).toBe(before.files);
    expect(after.storageBytes).toBe(before.storageBytes);
    expect(after.reservedBytes).toBe(0);
  });

  it("fails closed when the scanner is unreachable", async () => {
    const u = await createUser("Uploader");
    await setPlan(u.orgId, "research_pro");
    const body = Buffer.from("anything");
    await expect(svc(1).files.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "x.txt", declaredSize: body.length, body: streamOf(body) })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
