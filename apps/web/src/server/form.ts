import { isAppError, logger } from "@researchmate/shared";
import { unstable_rethrow } from "next/navigation";

/** State returned by server actions to <ActionForm>. */
export interface FormState {
  error?: string;
  success?: string;
  /** Arbitrary payload for one-time displays (e.g. recovery codes). */
  data?: Record<string, unknown>;
}

export const initialFormState: FormState = {};

/**
 * Runs an action and converts domain errors into a user-facing message.
 * Unexpected errors are logged and shown generically. Redirects pass through.
 */
export async function handle(fn: () => Promise<FormState | void>): Promise<FormState> {
  try {
    return (await fn()) ?? {};
  } catch (err) {
    unstable_rethrow(err); // let redirect()/notFound() propagate
    if (isAppError(err)) return { error: err.message };
    logger.error("action.failed", { error: err instanceof Error ? err.stack : String(err) });
    return { error: "Something went wrong on our side. Please try again." };
  }
}

export function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}
