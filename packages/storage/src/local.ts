import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type PutResult, type StorageDriver, UploadTooLargeError } from "./driver";

const HEAD_BYTES = 4100;

/**
 * Local filesystem driver.
 *
 * Layout under LOCAL_STORAGE_ROOT:
 *   files/      committed objects (key → path)
 *   temporary/  in-flight uploads; atomically renamed into files/ on success
 *   generated/  generated documents (later milestones)
 *   backups/    backup archives
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = "local" as const;
  private readonly filesRoot: string;
  private readonly tempRoot: string;

  constructor(private readonly root: string) {
    this.filesRoot = resolve(root, "files");
    this.tempRoot = resolve(root, "temporary");
  }

  async init(): Promise<void> {
    for (const d of ["files", "temporary", "generated", "backups"]) await mkdir(join(this.root, d), { recursive: true, mode: 0o750 });
  }

  /** Resolves a key to a path, refusing anything that escapes the files root. */
  pathFor(key: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,500}$/.test(key) || key.includes("..") || key.includes("//")) {
      throw new Error("Invalid storage key");
    }
    const p = resolve(this.filesRoot, key);
    if (!p.startsWith(this.filesRoot + sep)) throw new Error("Invalid storage key");
    return p;
  }

  async put(key: string, body: Readable | AsyncIterable<Uint8Array>, opts: { maxBytes: number }): Promise<PutResult> {
    const finalPath = this.pathFor(key);
    await mkdir(this.tempRoot, { recursive: true });
    const tempPath = join(this.tempRoot, `${randomUUID()}.part`);
    const hash = createHash("sha256");
    let size = 0;
    const headChunks: Buffer[] = [];
    let headLen = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > opts.maxBytes) return cb(new UploadTooLargeError(opts.maxBytes));
        hash.update(chunk);
        if (headLen < HEAD_BYTES) {
          const slice = chunk.subarray(0, HEAD_BYTES - headLen);
          headChunks.push(Buffer.from(slice));
          headLen += slice.length;
        }
        cb(null, chunk);
      },
    });

    try {
      await pipeline(body as Readable, meter, createWriteStream(tempPath, { flags: "wx", mode: 0o640 }));
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o750 });
      await rename(tempPath, finalPath);
    } catch (err) {
      await rm(tempPath, { force: true });
      throw err;
    }
    return { sizeBytes: size, checksumSha256: hash.digest("hex"), head: Buffer.concat(headChunks) };
  }

  async get(key: string): Promise<Readable> {
    const p = this.pathFor(key);
    await access(p);
    return createReadStream(p);
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async healthCheck(): Promise<void> {
    await mkdir(this.tempRoot, { recursive: true });
    const probe = join(this.tempRoot, `.health-${randomUUID()}`);
    await writeFile(probe, "ok");
    await unlink(probe);
  }

  /** Removes abandoned temporary uploads older than `maxAgeMs`. */
  async cleanTemporary(maxAgeMs: number): Promise<number> {
    let removed = 0;
    let entries: string[] = [];
    try {
      entries = await readdir(this.tempRoot);
    } catch {
      return 0;
    }
    for (const name of entries) {
      const p = join(this.tempRoot, name);
      try {
        const s = await stat(p);
        if (Date.now() - s.mtimeMs > maxAgeMs) {
          await rm(p, { force: true });
          removed++;
        }
      } catch {
        /* raced with another cleaner */
      }
    }
    return removed;
  }
}
