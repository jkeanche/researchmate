import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { forgotPasswordAction } from "@/server/actions/auth";

export const metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="text-2xl">Reset your password</h1>
      <p className="mt-2 text-sm text-graphite">Enter your account email and we'll send you a link to choose a new password.</p>
      <div className="mt-6">
        <ActionForm action={forgotPasswordAction} submitLabel="Email me a reset link" pendingLabel="Sending…">
          <Field label="Email" name="email" type="email" autoComplete="email" required />
        </ActionForm>
      </div>
      <p className="mt-6 text-sm text-graphite">
        <Link href="/login" className="underline-offset-2 hover:underline">Back to sign in</Link>
      </p>
    </>
  );
}
