import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { resendVerificationAction } from "@/server/actions/auth";

export const metadata = { title: "Check your email" };

export default async function CheckEmailPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { email = "" } = await searchParams;
  return (
    <>
      <h1 className="text-2xl">Check your email</h1>
      <p className="mt-3 text-graphite">
        We sent a verification link{email ? <> to <strong className="text-ink">{email}</strong></> : null}. Open it to finish creating your account. The link works for 24 hours.
      </p>
      <div className="mt-6">
        <ActionForm action={resendVerificationAction} submitLabel="Send a new link" variant="quiet">
          <input type="hidden" name="email" value={email} />
        </ActionForm>
      </div>
      <p className="mt-6 text-sm text-graphite">
        Already verified? <Link href="/login" className="font-semibold text-green">Sign in</Link>
      </p>
    </>
  );
}
