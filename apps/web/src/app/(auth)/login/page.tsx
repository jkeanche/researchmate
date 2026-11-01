import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, Field } from "@/components/action-form";
import { loginAction } from "@/server/actions/auth";
import { getSession } from "@/server/session";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  if (await getSession()) redirect("/app");
  const notice = sp.verified ? "Email verified. Sign in to continue." : sp.reset ? "Password updated. Sign in with your new password." : null;
  return (
    <>
      <h1 className="text-2xl">Sign in</h1>
      {notice && <p role="status" className="mt-4 rounded-md border border-green/30 bg-green-wash px-3 py-2 text-sm text-green-dark">{notice}</p>}
      <div className="mt-6">
        <ActionForm action={loginAction} submitLabel="Sign in" pendingLabel="Signing in…">
          <input type="hidden" name="next" value={sp.next ?? "/app"} />
          <Field label="Email" name="email" type="email" autoComplete="email" required />
          <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        </ActionForm>
      </div>
      <div className="mt-6 grid gap-1 text-sm text-graphite">
        <Link href="/forgot-password" className="underline-offset-2 hover:underline">Forgot your password?</Link>
        <span>
          New here? <Link href="/register" className="font-semibold text-green underline-offset-2 hover:underline">Create an account</Link>
        </span>
      </div>
    </>
  );
}
