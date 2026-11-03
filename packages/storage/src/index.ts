import { env } from "@researchmate/shared";
import type { StorageDriver } from "./driver";
import { LocalStorageDriver } from "./local";
import { S3StorageDriver } from "./s3";

export * from "./driver";
export * from "./local";
export * from "./s3";
export * from "./content-type";
export * from "./files";

let driver: StorageDriver | undefined;

/**
 * Returns the configured storage driver. Required S3 settings are validated
 * by the environment schema; the bucket is probed once so a misconfigured
 * bucket fails at startup instead of on the first upload.
 */
export async function getStorageDriver(): Promise<StorageDriver> {
  if (driver) return driver;
  const e = env();
  if (e.STORAGE_DRIVER === "s3") {
    const s3 = new S3StorageDriver({
      bucket: e.S3_BUCKET!,
      region: e.S3_REGION!,
      endpoint: e.S3_ENDPOINT,
      accessKeyId: e.S3_ACCESS_KEY_ID!,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      keyPrefix: e.S3_KEY_PREFIX,
    });
    await s3.healthCheck();
    driver = s3;
    return driver;
  }
  const local = new LocalStorageDriver(e.LOCAL_STORAGE_ROOT);
  await local.init();
  driver = local;
  return driver;
}
export * from "./clamav";
