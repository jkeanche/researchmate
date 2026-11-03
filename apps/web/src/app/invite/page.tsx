import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Wordmark } from "@/components/brand";
import { collaborationAction } from "@/server/actions/collaboration";
import { collaborationService } from "@/server/services";
import { getSession } from "@/server/session";

export const metadata = { title: "Invitation" };

const ROLE: Record<string, string> = { project_supervisor: "supervisor", project_researcher: "researcher", project_assistant: "research assistant", project_viewer: "viewer" };

export default async function InvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = ((await searchParams).token ?? "").slice(0, 100);
  const [info, session] = await Promise.all([token ? (await collaborationService()).describe(token) : null, getSession()]);
  const here = `/invite?token=${encodeURIComponent(token)}`;
  return (
    <main className="mx-auto grid min-h-screen max-w-lg content-center gap-6 px-4 py-12">
      <Wordmark />
      {!info ? (
        <p role="alert" className="rounded-md border border-margin/30 bg-margin-wash px-4 py-3 text-sm text-margin">This invitation link isn't valid. Ask the person who invited you for a new one.</p>
      ) : (
        <section className="rounded-md border border-rule bg-sheet p-6">
          <h1 className="font-serif text-2xl">You're invited</h1>
          <p className="mt-3">
            {info.invitedBy} invited you to join <strong>{info.projectTitle ?? info.organizationName}</strong>
            {info.role ? <> as {info.supervisorKind === "co_supervisor" ? "co-supervisor" : info.supervisorKind === "examiner" ? "examiner" : ROLE[info.role] ?? "a member"}</> : null}, in {info.organizationName}.
          </p>
          {info.message && <blockquote className="mt-3 border-l-2 border-rule pl-3 text-sm text-graphite">{info.message}</blockquote>}
          <p className="mt-3 text-sm text-graphite">Sent to {info.email}. {info.role === "project_supervisor" && "Supervisors can read the project, review submitted documents and give feedback; they can't change the research."}</p>
          <div className="mt-5">
            {info.status !== "pending" ? (
              <p role="alert" className="text-sm text-margin">{info.status === "accepted" ? "This invitation has already been accepted." : info.status === "expired" ? "This invitation has expired. Ask for a new one." : "This invitation was withdrawn."}</p>
            ) : session ? (
              session.user.email.toLowerCase() === info.email ? (
                <ActionForm action={collaborationAction} submitLabel="Accept invitation">
                  <input type="hidden" name="intent" value="accept_invitation" />
                  <input type="hidden" name="token" value={token} />
                </ActionForm>
              ) : (
                <p className="text-sm">You're signed in as {session.user.email}. Sign out, then sign in as {info.email} to accept.</p>
              )
            ) : (
              <div className="flex flex-wrap gap-3">
                <Link className="btn btn-primary" href={`/login?next=${encodeURIComponent(here)}`}>Sign in to accept</Link>
                <Link className="btn btn-quiet" href={`/register?email=${encodeURIComponent(info.email)}`}>Create an account</Link>
                <p className="w-full text-xs text-graphite">New here? After you verify your email and sign in, the invitation appears on your dashboard.</p>
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
