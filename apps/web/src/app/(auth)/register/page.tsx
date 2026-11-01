import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, Field } from "@/components/action-form";
import { registerAction } from "@/server/actions/auth";
import { getSession } from "@/server/session";

export const metadata = { title: "Create account" };

export default async function RegisterPage() {
  if (await getSession()) redirect("/app");
  return (
    <>
      <h1 className="text-2xl">Create your account</h1>
      <p className="mt-2 text-sm text-graphite">You'll start on the Free plan with a personal workspace.</p>
      <div className="mt-6">
        <ActionForm action={registerAction} submitLabel="Create account" pendingLabel="Creating account…">
          <Field label="Your name" name="displayName" autoComplete="name" required maxLength={100} />
          <Field label="Email" name="email" type="email" autoComplete="email" required />
          <Field label="Password" name="password" type="password" autoComplete="new-password" required minLength={10} hint="At least 10 characters. A short phrase works well." />
          <Field label="Confirm password" name="confirmPassword" type="password" autoComplete="new-password" required minLength={10} />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="terms" required className="mt-1" />
            <span>I agree to the terms and understand that I'm responsible for verifying research claims and following my institution's academic integrity rules.</span>
          </label>
        </ActionForm>
      </div>
      <p className="mt-6 text-sm text-graphite">
        Already have an account? <Link href="/login" className="font-semibold text-green underline-offset-2 hover:underline">Sign in</Link>
      </p>
    </>
  );
}
