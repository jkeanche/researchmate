import { env } from "@researchmate/shared";
import type { StorageDriver } from "./driver";
import { LocalStorageDriver } from "./local";

export * from "./driver";
export * from "./local";
export * from "./content-type";
export * from "./files";

let driver: StorageDriver | undefined;

/**
 * Returns the configured storage driver. The S3-compatible driver is part of
 * the storage milestone (Phase 4); selecting it now fails loudly rather than
 * silently writing somewhere unexpected.
 */
export async function getStorageDriver(): Promise<StorageDriver> {
  if (driver) return driver;
  const e = env();
  if (e.STORAGE_DRIVER === "s3") {
    throw new Error("STORAGE_DRIVER=s3 is not available yet (scheduled for the storage milestone). Use STORAGE_DRIVER=local.");
  }
  const local = new LocalStorageDriver(e.LOCAL_STORAGE_ROOT);
  await local.init();
  driver = local;
  return driver;
}
