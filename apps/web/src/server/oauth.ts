import { decryptSecret } from "@researchmate/shared";

export const OAUTH_COOKIE = "rm_google_oauth";
export const OAUTH_AAD = "google-oauth-state";

export function readOAuthCookie(value: string | undefined): { state: string; verifier: string; orgId: string; userId: string; at: number } | null {
  if (!value) return null;
  try {
    const v = JSON.parse(decryptSecret(value, OAUTH_AAD));
    return Date.now() - v.at < 600_000 ? v : null;
  } catch {
    return null;
  }
}
