import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { resetPasswordAction } from "@/server/actions/auth";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { token = "" } = await searchParams;
  if (!token) {
    return (
      <>
        <h1 className="text-2xl">Link incomplete</h1>
        <p className="mt-3 text-graphite">
          This reset link is missing its token. <Link href="/forgot-password" className="font-semibold text-green">Request a new link</Link>.
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className="text-2xl">Choose a new password</h1>
      <p className="mt-2 text-sm text-graphite">You'll be signed out on every device and can sign in again with the new password.</p>
      <div className="mt-6">
        <ActionForm action={resetPasswordAction} submitLabel="Save new password" pendingLabel="Saving…">
          <input type="hidden" name="token" value={token} />
          <Field label="New password" name="password" type="password" autoComplete="new-password" required minLength={10} hint="At least 10 characters." />
          <Field label="Confirm new password" name="confirmPassword" type="password" autoComplete="new-password" required minLength={10} />
        </ActionForm>
      </div>
    </>
  );
}
