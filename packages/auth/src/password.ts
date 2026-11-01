import { hash, verify } from "@node-rs/argon2";
import { AppError } from "@researchmate/shared";

/**
 * Argon2id with OWASP-recommended parameters (19 MiB, t=2, p=1).
 * Algorithm 2 = Argon2id in @node-rs/argon2.
 */
const OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export function validatePassword(password: string, email?: string): void {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) {
    throw new AppError("VALIDATION", `Password must be at least ${PASSWORD_MIN} characters.`);
  }
  if (password.length > PASSWORD_MAX) throw new AppError("VALIDATION", `Password must be at most ${PASSWORD_MAX} characters.`);
  if (email && password.toLowerCase().includes(email.split("@")[0]!.toLowerCase()) && email.split("@")[0]!.length >= 4) {
    throw new AppError("VALIDATION", "Password must not contain your email address.");
  }
  if (/^(.)\1+$/.test(password)) throw new AppError("VALIDATION", "Password is too easy to guess.");
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/** Burns comparable time when the account does not exist, to reduce user-enumeration timing signals. */
export async function verifyDummyPassword(password: string): Promise<void> {
  dummyHash ??= hashPassword("researchmate-dummy-password-for-timing");
  await verifyPassword(await dummyHash, password);
}
