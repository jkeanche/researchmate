import { ActionForm } from "@/components/action-form";
import { verifyEmailAction } from "@/server/actions/auth";

export const metadata = { title: "Verify email" };

/**
 * Verification is a POST (button), not a GET side effect, so link scanners
 * in email clients can't consume the token before the user does.
 */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { token = "" } = await searchParams;
  return (
    <>
      <h1 className="text-2xl">Verify your email</h1>
      {token ? (
        <>
          <p className="mt-3 text-graphite">Confirm that this email address belongs to you.</p>
          <div className="mt-6">
            <ActionForm action={verifyEmailAction} submitLabel="Verify email" pendingLabel="Verifying…">
              <input type="hidden" name="token" value={token} />
            </ActionForm>
          </div>
        </>
      ) : (
        <p className="mt-3 text-graphite">This link is missing its token. Open the link from your email again.</p>
      )}
    </>
  );
}
