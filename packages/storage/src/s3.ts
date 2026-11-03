import { createHash, randomUUID } from "node:crypto";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { type PutResult, type StorageDriver, UploadTooLargeError } from "./driver";

const HEAD_BYTES = 4100;
const PART_SIZE = 8 * 1024 * 1024;

export interface S3DriverConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  keyPrefix?: string;
}

/**
 * S3-compatible storage driver (AWS S3, MinIO, Wasabi, Backblaze B2, Cloudflare R2, …).
 *
 * Uploads stream through a byte meter into a multipart upload, so memory use
 * is bounded by the part size and an oversized upload is aborted before it
 * completes: S3 never exposes an object for an aborted multipart upload, so
 * nothing is left behind (the equivalent of the local driver's temp-file +
 * rename). Keys use the same validation as the local driver.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(cfg: S3DriverConfig, client?: S3Client) {
    this.bucket = cfg.bucket;
    this.prefix = cfg.keyPrefix ? cfg.keyPrefix.replace(/^\/+|\/+$/g, "") + "/" : "";
    this.client =
      client ??
      new S3Client({
        region: cfg.region,
        endpoint: cfg.endpoint || undefined,
        forcePathStyle: cfg.forcePathStyle ?? false,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
        // Only send/verify checksums when the operation requires them; several
        // S3-compatible servers reject the newer default CRC32 trailers.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
  }

  objectKey(key: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,500}$/.test(key) || key.includes("..") || key.includes("//")) {
      throw new Error("Invalid storage key");
    }
    return this.prefix + key;
  }

  async put(key: string, body: Readable | AsyncIterable<Uint8Array>, opts: { maxBytes: number }): Promise<PutResult> {
    const Key = this.objectKey(key);
    const hash = createHash("sha256");
    let size = 0;
    let tooLarge = false;
    const headChunks: Buffer[] = [];
    let headLen = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > opts.maxBytes) {
          tooLarge = true;
          return cb(new UploadTooLargeError(opts.maxBytes));
        }
        hash.update(chunk);
        if (headLen < HEAD_BYTES) {
          const slice = chunk.subarray(0, HEAD_BYTES - headLen);
          headChunks.push(Buffer.from(slice));
          headLen += slice.length;
        }
        cb(null, chunk);
      },
    });
    const pass = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key, Body: pass, ContentType: "application/octet-stream" },
      partSize: PART_SIZE,
      queueSize: 2,
      leavePartsOnError: false,
    });

    const piping = pipeline(Readable.from(body as AsyncIterable<Uint8Array>), meter, pass);
    piping.catch(() => {}); // surfaced through Promise.all below
    try {
      await Promise.all([piping, upload.done()]);
    } catch (err) {
      pass.destroy();
      await upload.abort().catch(() => {});
      // If a small upload was already sent as a single PUT before the error, remove it.
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key })).catch(() => {});
      if (tooLarge) throw new UploadTooLargeError(opts.maxBytes);
      throw err;
    }
    return { sizeBytes: size, checksumSha256: hash.digest("hex"), head: Buffer.concat(headChunks) };
  }

  async get(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
    if (!res.Body) throw new Error("Empty object body");
    return res.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    // DeleteObject is idempotent: deleting a missing key succeeds.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return true;
    } catch (err) {
      if (err instanceof S3ServiceException && (err.$metadata.httpStatusCode === 404 || err.name === "NotFound")) return false;
      throw err;
    }
  }

  async healthCheck(): Promise<void> {
    const Key = this.objectKey(`health/${randomUUID()}`);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key, Body: "ok" }));
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }));
  }

  destroy(): void {
    this.client.destroy();
  }
}
