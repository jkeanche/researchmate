import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, verifyTotp, validatePassword } from "@researchmate/auth";
import { decryptSecret, encryptSecret, parseEnv } from "@researchmate/shared";
import { detectContentType, sanitizeFilename } from "@researchmate/storage";
import { slugify } from "@researchmate/tenancy";
import { formatBytes } from "@researchmate/entitlements";

describe("TOTP (RFC 4226 / 6238)", () => {
  // RFC 4226 Appendix D test vectors, secret "12345678901234567890".
  const secret = Buffer.from("12345678901234567890");
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];

  it("matches RFC 4226 HOTP vectors", () => {
    expected.forEach((code, counter) => expect(hotp(secret, counter)).toBe(code));
  });

  it("matches RFC 6238 TOTP vector at T=59s (6 digits)", () => {
    const b32 = base32Encode(secret);
    expect(verifyTotp(b32, "287082", { nowMs: 59_000, window: 0 })).toBe(1);
  });

  it("accepts ±1 step drift only", () => {
    const b32 = base32Encode(secret);
    const now = 30_000 * 100;
    expect(verifyTotp(b32, hotp(secret, 99), { nowMs: now })).toBe(99);
    expect(verifyTotp(b32, hotp(secret, 101), { nowMs: now })).toBe(101);
    expect(verifyTotp(b32, hotp(secret, 97), { nowMs: now })).toBeNull();
    expect(verifyTotp(b32, "12345", { nowMs: now })).toBeNull();
  });

  it("round-trips base32", () => {
    const buf = Buffer.from("researchmate-secret-bytes");
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
});

describe("secret encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret("top secret", "aad");
    const b = encryptSecret("top secret", "aad");
    expect(a).not.toBe(b);
    expect(decryptSecret(a, "aad")).toBe("top secret");
  });

  it("rejects tampering and wrong associated data", () => {
    const enc = encryptSecret("value", "user-1");
    expect(() => decryptSecret(enc, "user-2")).toThrow();
    const parts = enc.split(":");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join(":"), "user-1")).toThrow();
  });
});

describe("environment validation", () => {
  const good = {
    APP_SECRET: "x".repeat(40),
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    DATABASE_URL: "postgres://u@h/db",
    REDIS_URL: "redis://h:6379",
  };

  it("accepts a minimal valid configuration", () => {
    expect(parseEnv(good).STORAGE_DRIVER).toBe("local");
  });

  it("fails when secrets are missing or weak", () => {
    expect(() => parseEnv({ ...good, APP_SECRET: undefined })).toThrow(/APP_SECRET/);
    expect(() => parseEnv({ ...good, ENCRYPTION_KEY: "short" })).toThrow(/ENCRYPTION_KEY/);
  });

  it("enforces production requirements", () => {
    expect(() => parseEnv({ ...good, NODE_ENV: "production", APP_URL: "http://example.com" })).toThrow(/APP_URL|EMAIL_HOST/);
  });

  it("allows plain http in production only on loopback", () => {
    const prod = { ...good, NODE_ENV: "production", EMAIL_HOST: "smtp.example.com" };
    expect(parseEnv({ ...prod, APP_URL: "http://localhost:3000" }).APP_URL).toBe("http://localhost:3000");
    expect(() => parseEnv({ ...prod, APP_URL: "http://researchmate.example.com" })).toThrow(/https/);
    expect(parseEnv({ ...prod, APP_URL: "https://researchmate.example.com" }).NODE_ENV).toBe("production");
  });

  it("requires S3 settings when the S3 driver is selected", () => {
    expect(() => parseEnv({ ...good, STORAGE_DRIVER: "s3" })).toThrow(/S3_BUCKET/);
  });
});

describe("password policy", () => {
  it("rejects short, repetitive and email-derived passwords", () => {
    expect(() => validatePassword("short")).toThrow();
    expect(() => validatePassword("aaaaaaaaaaaa")).toThrow();
    expect(() => validatePassword("janedoe-is-great", "janedoe@example.com")).toThrow();
    expect(() => validatePassword("correct horse battery staple", "jane@example.com")).not.toThrow();
  });
});

describe("upload content validation", () => {
  it("accepts a real PDF header with .pdf", async () => {
    await expect(detectContentType("paper.pdf", Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj"))).resolves.toBe("application/pdf");
  });

  it("rejects a PDF renamed to .docx and an executable renamed to .pdf", async () => {
    await expect(detectContentType("paper.docx", Buffer.from("%PDF-1.7\n"))).rejects.toThrow();
    await expect(detectContentType("evil.pdf", Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"))).rejects.toThrow();
  });

  it("validates text formats and rejects binaries posing as text", async () => {
    await expect(detectContentType("data.csv", Buffer.from("a,b\n1,2\n"))).resolves.toBe("text/csv");
    await expect(detectContentType("data.csv", Buffer.from([0x00, 0x01, 0x02]))).rejects.toThrow();
  });

  it("rejects unsupported extensions", async () => {
    await expect(detectContentType("script.exe", Buffer.from("MZ"))).rejects.toThrow(/not supported/);
  });

  it("sanitises filenames", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\thesis draft.docx")).toBe("thesis draft.docx");
    expect(sanitizeFilename("..hidden.txt")).toBe("hidden.txt");
    expect(() => sanitizeFilename("///")).toThrow();
  });
});

describe("misc", () => {
  it("slugifies organization names with a random suffix", () => {
    expect(slugify("Kenyatta University — Research Lab")).toMatch(/^kenyatta-university-research-lab-[a-z0-9]+$/);
  });
  it("formats bytes", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(512)).toBe("512 B");
  });
});
