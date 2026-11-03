import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Notice } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { projectMemberAction } from "@/server/actions/planning";
import { loadProject } from "@/server/plan";
import { collaborationAction } from "@/server/actions/collaboration";
import { collaborationService, memberService } from "@/server/services";
import { formatDate } from "@/lib/format";
import { Field } from "@/components/action-form";

export const metadata = { title: "Project team" };

export default async function TeamPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { session, can, archived } = await loadProject(projectId);
  const { members, candidates, roles } = await memberService().list(session.user.id, projectId);
  const collab = await collaborationService();
  const [supervisors, pending] = await Promise.all([collab.supervisors(session.user.id, projectId), collab.listInvitations(session.user.id, projectId)]);
  const KIND: Record<string, string> = { primary: "Supervisor", co_supervisor: "Co-supervisor", examiner: "Examiner" };
  const manage = can("project.members.manage") && !archived;
  const hidden = <input type="hidden" name="projectId" value={projectId} />;

  return (
    <>
      <Section title="People on this project" description="Organization owners and admins can see every project without being listed here.">
        <ul className="ruled max-w-3xl">
          {members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <span>
                <span className="font-semibold">{m.displayName ?? m.email}</span>
                <span className="block text-sm text-graphite">{m.email}</span>
              </span>
              {manage ? (
                <span className="flex flex-wrap items-center gap-2">
                  <ActionForm action={projectMemberAction} submitLabel="Change" variant="quiet" className="flex items-center gap-2">
                    {hidden}
                    <input type="hidden" name="userId" value={m.userId} />
                    <label className="sr-only" htmlFor={`role-${m.userId}`}>Role for {m.displayName}</label>
                    <select id={`role-${m.userId}`} name="roleKey" className="input py-1.5 text-sm" defaultValue={m.roleKey}>
                      {roles.map((r) => (
                        <option key={r.key} value={r.key}>{r.name}</option>
                      ))}
                    </select>
                  </ActionForm>
                  {m.userId !== session.user.id && (
                    <ActionForm action={projectMemberAction} submitLabel="Remove" variant="danger" className="flex">
                      {hidden}
                      <input type="hidden" name="userId" value={m.userId} />
                      <input type="hidden" name="intent" value="remove" />
                    </ActionForm>
                  )}
                </span>
              ) : (
                <span className="text-sm text-graphite">{m.roleName}</span>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Supervisors" description="Supervisors read the project, review submitted documents, give feedback and verify revisions. They can't edit the research.">
        {supervisors.length === 0 ? (
          <p className="mb-4 text-sm text-graphite">No supervisor yet.</p>
        ) : (
          <ul className="ruled mb-4 max-w-3xl">
            {supervisors.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <span>
                  <span className="font-semibold">{s.name ?? s.email}</span> <span className="text-sm text-graphite">· {KIND[s.kind]} since {formatDate(s.since)}</span>
                  <span className="block text-sm text-graphite">{s.email}</span>
                </span>
                {manage && (
                  <ActionForm action={collaborationAction} submitLabel="End supervision" variant="quiet" className="flex">
                    {hidden}
                    <input type="hidden" name="intent" value="end_supervision" />
                    <input type="hidden" name="assignmentId" value={s.id} />
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {manage && (
        <Section title="Invite by email" description="For supervisors and collaborators outside your organization, or without an account yet. They join this project only.">
          <div className="max-w-2xl">
            <ActionForm action={collaborationAction} submitLabel="Send invitation" resetOnSuccess className="grid gap-4">
              {hidden}
              <input type="hidden" name="intent" value="invite" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="inv-email" label="Email" name="email" type="email" required maxLength={320} />
                <div className="field">
                  <label htmlFor="inv-kind">Invite as</label>
                  <select id="inv-kind" name="kind" className="input" defaultValue="supervisor">
                    <option value="supervisor">Supervisor</option>
                    <option value="collaborator">Collaborator</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="inv-skind">Supervisor type</label>
                  <select id="inv-skind" name="supervisorKind" className="input" defaultValue="primary">
                    <option value="primary">Supervisor</option>
                    <option value="co_supervisor">Co-supervisor</option>
                    <option value="examiner">Examiner</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="inv-role">Collaborator role</label>
                  <select id="inv-role" name="projectRoleKey" className="input" defaultValue="project_researcher">
                    <option value="project_researcher">Researcher</option>
                    <option value="project_assistant">Research assistant</option>
                    <option value="project_viewer">Viewer</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="inv-msg">Message (optional)</label>
                <textarea id="inv-msg" name="message" className="input min-h-16" maxLength={1000} />
              </div>
            </ActionForm>
          </div>
          {pending.length > 0 && (
            <>
              <h3 className="mt-6 mb-2 font-sans text-sm font-semibold">Waiting for a reply</h3>
              <ul className="ruled max-w-3xl">
                {pending.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                    <span>{i.email} <span className="text-graphite">· {i.projectRoleKey === "project_supervisor" ? KIND[i.supervisorKind ?? "primary"] : roles.find((r) => r.key === i.projectRoleKey)?.name} · expires {formatDate(i.expiresAt)}</span></span>
                    <span className="flex gap-2">
                      {(["resend", "revoke"] as const).map((k) => (
                        <ActionForm key={k} action={collaborationAction} submitLabel={k === "resend" ? "Resend" : "Withdraw"} variant={k === "revoke" ? "danger" : "quiet"} className="flex">
                          {hidden}
                          <input type="hidden" name="intent" value={k} />
                          <input type="hidden" name="invitationId" value={i.id} />
                        </ActionForm>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      )}

      {manage && (
        <Section title="Add someone">
          {candidates.length === 0 ? (
            <Notice>
              Everyone in your organization is already on this project. <Link href="/app/settings/organization">Add people to the organization</Link> first.
            </Notice>
          ) : (
            <div className="max-w-2xl">
              <ActionForm action={projectMemberAction} submitLabel="Add to project" className="grid gap-4 sm:grid-cols-2">
                {hidden}
                <div className="field">
                  <label htmlFor="m-user">Person</label>
                  <select id="m-user" name="userId" className="input">
                    {candidates.map((c) => (
                      <option key={c.userId} value={c.userId}>{c.displayName ?? c.email}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="m-role">Role</label>
                  <select id="m-role" name="roleKey" className="input" defaultValue="project_researcher">
                    {roles.map((r) => (
                      <option key={r.key} value={r.key}>{r.name}</option>
                    ))}
                  </select>
                </div>
              </ActionForm>
            </div>
          )}
          <dl className="mt-6 grid max-w-3xl gap-2 text-sm">
            {roles.map((r) => (
              <div key={r.key} className="grid grid-cols-[10rem_1fr] gap-3">
                <dt className="font-semibold">{r.name}</dt>
                <dd className="text-graphite">{r.description}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
    </>
  );
}
