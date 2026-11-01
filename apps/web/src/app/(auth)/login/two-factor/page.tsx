import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ActionForm, Field } from "@/components/action-form";
import { twoFactorLoginAction } from "@/server/actions/auth";
import { CHALLENGE_COOKIE } from "@/server/session";

export const metadata = { title: "Two-factor sign-in" };

export default async function TwoFactorPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  if (!(await cookies()).get(CHALLENGE_COOKIE())) redirect("/login");
  return (
    <>
      <h1 className="text-2xl">Enter your code</h1>
      <p className="mt-2 text-sm text-graphite">Open your authenticator app and enter the 6-digit code for ResearchMate. Lost your phone? Use one of your recovery codes instead.</p>
      <div className="mt-6">
        <ActionForm action={twoFactorLoginAction} submitLabel="Verify and sign in" pendingLabel="Verifying…">
          <input type="hidden" name="next" value={sp.next ?? "/app"} />
          <Field label="Authentication or recovery code" name="code" autoComplete="one-time-code" inputMode="text" required autoFocus maxLength={16} />
        </ActionForm>
      </div>
      <p className="mt-6 text-sm text-graphite">
        <Link href="/login" className="underline-offset-2 hover:underline">Start over</Link>
      </p>
    </>
  );
}
