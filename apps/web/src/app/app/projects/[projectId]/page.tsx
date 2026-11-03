import { getEntitlements, limitOf } from "@researchmate/entitlements";
import { diffDays } from "@researchmate/planning";
import { CITATION_STYLE_LABELS, PROJECT_STATUSES, RESEARCH_TYPE_LABELS, STATUS_LABELS } from "@researchmate/research";
import { env } from "@researchmate/shared";
import { ACCEPT_ATTRIBUTE } from "@researchmate/storage";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { ConfirmAction, FileUploader } from "@/components/client-bits";
import { FileList } from "@/components/file-list";
import { Flag, formatDuration, Stat } from "@/components/plan-ui";
import { ProjectFields } from "@/components/project-fields";
import { Section } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { progressSourceAction } from "@/server/actions/planning";
import { archiveProjectAction, updateProjectAction } from "@/server/actions/workspace";
import { loadPlanView } from "@/server/plan";
import { db, fileService, planningService, workflowService } from "@/server/services";

export const metadata = { title: "Project" };

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const v = await loadPlanView(projectId);
  const { project: p, can, archived, session } = v;
  const uid = session.user.id;

  const [files, ent, wf, risks, time] = await Promise.all([
    fileService().then((s) => s.list(uid, p.organizationId, { projectId: p.id })),
    getEntitlements(db(), p.organizationId),
    workflowService().list(uid, projectId),
    planningService().listRisks(uid, projectId),
    planningService().listTime(uid, projectId),
  ]);
  const maxFile = Math.min(limitOf(ent, "files.max_size_bytes") ?? Infinity, env().MAX_UPLOAD_SIZE_MB * 1024 * 1024);

  const leaves = v.tasks.filter((t) => !t.isSummary && t.status !== "cancelled");
  const doneCount = leaves.filter((t) => t.status === "done").length;
  const overdue = leaves.filter((t) => t.overdue);
  const upcoming = v.tasks
    .filter((t) => t.kind === "milestone" && t.status !== "done" && t.startDate >= v.today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, 4);
  const dueSoon = leaves
    .filter((t) => t.status !== "done" && !t.overdue && t.endDate <= addDaysIso(v.today, 14))
    .sort((a, b) => a.endDate.localeCompare(b.endDate))
    .slice(0, 6);
  const slip = v.expectedCompletion && v.estimatedCompletion ? diffDays(v.expectedCompletion, v.estimatedCompletion) : null;
  const highRisks = risks.filter((r) => (r.risk.status === "open" || r.risk.status === "occurred") && r.risk.likelihood * r.risk.impact >= 15);
  const stage = wf.stages.find((s) => s.enabled && (s.status === "in_progress" || s.status === "awaiting_approval")) ?? wf.stages.find((s) => s.enabled && s.status === "not_started");
  const awaiting = wf.stages.filter((s) => s.status === "awaiting_approval");
  const base = `/app/projects/${projectId}`;

  const facts: [string, string][] = [
    ["Research type", RESEARCH_TYPE_LABELS[p.researchType as keyof typeof RESEARCH_TYPE_LABELS]],
    ["Academic level", p.academicLevel ?? "—"],
    ["Discipline", p.discipline ?? "—"],
    ["Institution", [p.institution, p.department].filter(Boolean).join(", ") || "—"],
    ["Citation style", CITATION_STYLE_LABELS[p.citationStyle as keyof typeof CITATION_STYLE_LABELS]],
    ["Target length", [p.targetWordCount ? `${p.targetWordCount.toLocaleString()} words` : null, p.targetPageCount ? `${p.targetPageCount} pages` : null].filter(Boolean).join(", ") || "—"],
    ["Schedule", p.startDate || p.expectedCompletionDate ? `${formatDate(p.startDate)} to ${formatDate(p.expectedCompletionDate)}` : "—"],
  ];

  return (
    <>
      <Section title="Status">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Tasks done" value={leaves.length ? `${doneCount} / ${leaves.length}` : "—"} note={`${p.progressPercent}% complete${p.progressSource === "tasks" ? ", by task duration" : ", set manually"}`} />
          <Stat label="Overdue" value={overdue.length} tone={overdue.length ? "bad" : leaves.length ? "good" : undefined} note={overdue.length ? "Past their end date" : "Nothing late"} />
          <Stat
            label="Forecast completion"
            value={v.estimatedCompletion ? formatDate(v.estimatedCompletion) : "—"}
            tone={slip !== null && slip > 0 ? "bad" : slip !== null ? "good" : undefined}
            note={slip === null ? (v.expectedCompletion ? "Add tasks to forecast" : "No target date set") : slip > 0 ? `${slip} days after ${formatDate(v.expectedCompletion)}` : `On track for ${formatDate(v.expectedCompletion)}`}
          />
          <Stat label="Current stage" value={<span className="text-lg">{stage?.name ?? "—"}</span>} note={awaiting.length ? `${awaiting.length} awaiting approval · waited ${formatDuration(wf.waitingSeconds)}` : wf.stages.length ? `${wf.stages.filter((s) => s.status === "completed").length} of ${wf.stages.filter((s) => s.enabled).length} stages complete` : "No workflow"} />
        </div>
        <div className="mt-6 grid gap-8 md:grid-cols-3">
          <div>
            <h3 className="mb-2 font-sans text-sm font-semibold">Needs attention</h3>
            <ul className="ruled text-sm">
              {overdue.slice(0, 5).map((t) => (
                <li key={t.id} className="py-1.5">
                  <Link href={`${base}/tasks/${t.id}`}>{t.title}</Link> <Flag kind="overdue" />
                  <span className="block text-xs text-graphite">Due {formatDate(t.endDate)}{t.assigneeName ? ` · ${t.assigneeName}` : ""}</span>
                </li>
              ))}
              {highRisks.slice(0, 3).map(({ risk }) => (
                <li key={risk.id} className="py-1.5">
                  <Link href={`${base}/risks`}>{risk.title}</Link>
                  <span className="block text-xs text-margin">High risk · score {risk.likelihood * risk.impact}</span>
                </li>
              ))}
              {awaiting.map((s) => (
                <li key={s.id} className="py-1.5">
                  <Link href={`${base}/workflow`}>{s.name}</Link>
                  <span className="block text-xs text-amber">Waiting for approval</span>
                </li>
              ))}
              {!overdue.length && !highRisks.length && !awaiting.length && <li className="py-1.5 text-graphite">Nothing urgent.</li>}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 font-sans text-sm font-semibold">Due in the next two weeks</h3>
            <ul className="ruled text-sm">
              {dueSoon.map((t) => (
                <li key={t.id} className="py-1.5">
                  <Link href={`${base}/tasks/${t.id}`}>{t.title}</Link>
                  <span className="block text-xs text-graphite">{formatDate(t.endDate)}{t.assigneeName ? ` · ${t.assigneeName}` : ""} · {t.progress}%</span>
                </li>
              ))}
              {!dueSoon.length && <li className="py-1.5 text-graphite">{leaves.length ? "Nothing due soon." : <Link href={`${base}/tasks`}>Plan your first tasks</Link>}</li>}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 font-sans text-sm font-semibold">Next milestones</h3>
            <ul className="ruled text-sm">
              {upcoming.map((m) => (
                <li key={m.id} className="py-1.5">
                  ◆ <Link href={`${base}/tasks/${m.id}`}>{m.title}</Link>
                  <span className="block text-xs text-graphite">{formatDate(m.startDate)} · in {diffDays(v.today, m.startDate)} days</span>
                </li>
              ))}
              {!upcoming.length && <li className="py-1.5 text-graphite">No upcoming milestones.</li>}
            </ul>
            {time.totalMinutes > 0 && <p className="mt-3 text-xs text-graphite">{Math.round(time.totalMinutes / 60)} h logged · <Link href={`${base}/time`}>Time and workload</Link></p>}
          </div>
        </div>
      </Section>

      <Section
        title="Overview"
        aside={
          can("project.archive") ? (
            <ConfirmAction
              action={archiveProjectAction}
              fields={{ projectId: p.id, intent: archived ? "restore" : "archive" }}
              label={archived ? "Restore project" : "Archive project"}
              variant="quiet"
              confirmText={archived ? "Restore this project so it can be edited again?" : "Archive this project? It becomes read-only. Archived projects still count toward your plan's project limit."}
            />
          ) : null
        }
      >
        {p.description ? <p className="mb-5 max-w-2xl whitespace-pre-line">{p.description}</p> : null}
        <dl className="grid max-w-3xl gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          {facts.map(([k, val]) => (
            <div key={k} className="grid grid-cols-[8.5rem_1fr] gap-2">
              <dt className="text-graphite">{k}</dt>
              <dd>{val}</dd>
            </div>
          ))}
        </dl>
        {p.methodology ? (
          <div className="mt-5 max-w-2xl text-sm">
            <p className="text-graphite">Methodology</p>
            <p className="mt-1 whitespace-pre-line">{p.methodology}</p>
          </div>
        ) : null}
      </Section>

      <Section title="Files" description="Readings, datasets, drafts and other material for this project.">
        {can("project.files.write") && !archived ? (
          <div className="mb-6">
            <FileUploader organizationId={p.organizationId} projectId={p.id} accept={ACCEPT_ATTRIBUTE} maxBytes={maxFile} />
          </div>
        ) : null}
        <FileList rows={files} canDelete={() => can("project.files.delete") && !archived} />
      </Section>

      {can("project.update") && !archived && (
        <Section title="Edit project">
          <div className="grid max-w-2xl gap-10">
            <ActionForm action={progressSourceAction} submitLabel="Save progress setting" className="grid gap-4">
              <input type="hidden" name="projectId" value={p.id} />
              <fieldset className="grid gap-2 text-sm">
                <legend className="mb-1 font-semibold">Progress</legend>
                <label className="flex items-center gap-2">
                  <input type="radio" name="progressSource" value="tasks" defaultChecked={p.progressSource === "tasks"} /> Follow task progress (weighted by task length)
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="progressSource" value="manual" defaultChecked={p.progressSource === "manual"} /> Set manually:
                  <input name="progressPercent" type="number" min={0} max={100} step={5} className="input w-24 py-1" defaultValue={p.progressPercent} aria-label="Manual progress percentage" />%
                </label>
              </fieldset>
            </ActionForm>
            <ActionForm action={updateProjectAction} submitLabel="Save changes" pendingLabel="Saving…" className="grid gap-6">
              <input type="hidden" name="projectId" value={p.id} />
              <div className="field max-w-xs">
                <label htmlFor="f-status">Status</label>
                <select id="f-status" name="status" className="input" defaultValue={p.status}>
                  {PROJECT_STATUSES.filter((s) => s !== "archived").map((s) => (
                    <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                  ))}
                </select>
              </div>
              <ProjectFields d={p} />
            </ActionForm>
          </div>
        </Section>
      )}
    </>
  );
}

function addDaysIso(iso: string, days: number) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
