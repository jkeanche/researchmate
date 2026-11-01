/**
 * Domain errors. Services throw these; the web layer maps them to user-facing
 * messages and HTTP status codes. Messages must be safe to show to end users.
 */
export type AppErrorCode =
  | "VALIDATION"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "FEATURE_NOT_ENTITLED"
  | "READ_ONLY"
  | "TWO_FACTOR_REQUIRED"
  | "INTERNAL";

const STATUS: Record<AppErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 402,
  FEATURE_NOT_ENTITLED: 402,
  READ_ONLY: 423,
  TWO_FACTOR_REQUIRED: 401,
  INTERNAL: 500,
};

const BRAND = Symbol.for("researchmate.AppError");

export class AppError extends Error {
  readonly [BRAND] = true;
  readonly code: AppErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS[this.code];
  }
}

/**
 * Brand check instead of instanceof: bundlers can load this module more than
 * once (e.g. separate server chunks), which breaks instanceof across copies.
 */
export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[BRAND] === true;
}
