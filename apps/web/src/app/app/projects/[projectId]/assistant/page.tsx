import { AGENTS } from "@researchmate/ai";
import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Notice, PlanNotice, Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { formatUsd } from "@researchmate/billing";
import { aiRunControlAction, startAgentAction } from "@/server/actions/ai";
import { loadProject } from "@/server/plan";
import { aiService, collaborationService, literatureService } from "@/server/services";

export const metadata = { title: "AI assistant" };

const KIND_LABEL: Record<string, string> = { research_question: "Research question", objective: "Objective", risk: "Risk", task: "Task", evidence: "Evidence", matrix_entry: "Matrix row", revision_task: "Revision task" };
const STATUS_TONE: Record<string, string> = { queued: "todo", running: "in_progress", succeeded: "done", failed: "blocked", cancelled: "cancelled" };

function describe(kind: string, p: Record<string, unknown>) {
  if (kind === "risk") return `${p.title} · ${String(p.category).replace("_", " ")} · likelihood ${p.likelihood}, impact ${p.impact}. Mitigation: ${p.mitigation}`;
  if (kind === "research_question") return `${p.kind === "main" ? "Main: " : ""}${p.text}`;
  if (kind === "revision_task") return `${p.title}${p.description ? ` — ${p.description}` : ""}`;
  if (kind === "evidence") return `“${p.passage}”${p.page ? ` (p. ${p.page})` : ""} — supports: ${p.claim}`;
  return String(p.text ?? JSON.stringify(p));
}

export default async function AssistantPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { session, can, archived, project } = await loadProject(projectId);
  const uid = session.user.id;
  const [usage, keys, runs, refs] = await Promise.all([aiService().usage(project.organizationId), aiService().listCredentials(uid, project.organizationId), aiService().listRuns(uid, projectId), literatureService().list(uid, projectId)]);
  const withText = refs.filter((r) => r.accessLevel === "full_text" && r.fileId);
  const reviewed = (await (await collaborationService()).list(uid, projectId)).filter((x) => x.r.status === "changes_requested" || x.r.status === "in_review");
  const active = runs.some((r) => r.status === "queued" || r.status === "running");
  const hidden = <input type="hidden" name="projectId" value={projectId} />;
  const platform = await aiService().platformStatus(project.organizationId);
  // Funding is chosen explicitly: your own key (never charged by ResearchMate) or ResearchMate credit.
  const payOptions = [...keys.map((k) => ({ value: `key:${k.id}`, label: `Your key: ${k.label} (${k.defaultModel})` })), ...(platform.available ? [{ value: "platform", label: `ResearchMate credit (${formatUsd(Math.max(0, platform.balance.availableMicros))} available)` }] : [])];
  const keyPicker =
    payOptions.length > 1 ? (
      <div className="field">
        <label htmlFor="ai-pay">Pay with</label>
        <select id="ai-pay" name="payWith" className="input">
          {payOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    ) : payOptions.length === 1 ? (
      <input type="hidden" name="payWith" value={payOptions[0]!.value} />
    ) : null;

  if (usage.tier === "none") return <PlanNotice>AI assistance is not included in the {usage.planName} plan.</PlanNotice>;
  if (!payOptions.length)
    return (
      <Notice>
        AI features use your own provider key. <Link href="/app/settings/ai">Add an AI key</Link> to get started.
      </Notice>
    );

  const agentCard = (key: string, extra?: React.ReactNode) => {
    const a = AGENTS[key]!;
    const allowed = can(a.permission) && (!archived || a.permission === "project.read");
    return (
      <div key={key} className="rounded-md border border-rule bg-sheet p-4">
        <h3 className="font-sans text-base font-semibold">{a.title}</h3>
        <p className="mt-1 mb-3 text-sm text-graphite">{a.description}</p>
        {allowed ? (
          <ActionForm action={startAgentAction} submitLabel="Run" variant="quiet" className="grid gap-3">
            {hidden}
            <input type="hidden" name="agentKey" value={key} />
            {extra}
            {keyPicker}
          </ActionForm>
        ) : (
          <p className="text-xs text-graphite">You need edit access to this project.</p>
        )}
      </div>
    );
  };

  return (
    <>
      <AutoRefresh active={active} />
      <p className="mb-6 max-w-3xl text-sm text-graphite">
        AI suggestions are drafts for you to review. Nothing changes in the project until you accept a suggestion or an approver accepts a proposed schedule. AI never invents sources or results. {usage.monthlyLimit !== null && `${usage.usedThisMonth} of ${usage.monthlyLimit} runs used this month.`}
      </p>

      <Section title="Ask about this project">
        <div className="max-w-3xl">
          <ActionForm action={startAgentAction} submitLabel="Ask" resetOnSuccess className="grid gap-3">
            {hidden}
            <input type="hidden" name="agentKey" value="assistant" />
            <div className="field">
              <label htmlFor="ai-q">Question</label>
              <textarea id="ai-q" name="question" className="input min-h-20" required maxLength={4000} placeholder="e.g. What is overdue, and what should I do next?" />
            </div>
            {keyPicker}
          </ActionForm>
        </div>
      </Section>

      <Section title="Agents">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {agentCard("research-questions")}
          {agentCard("risk-assessment")}
          {agentCard("project-planning", <Field id="ai-guidance" label="Guidance (optional)" name="guidance" maxLength={1000} placeholder="e.g. No fieldwork in December" />)}
          {agentCard(
            "evidence-extraction",
            withText.length ? (
              <div className="field">
                <label htmlFor="ai-ref">Source with full text</label>
                <select id="ai-ref" name="referenceId" className="input" required>
                  {withText.map((r) => <option key={r.id} value={r.id}>[@{r.citationKey}] {r.title.slice(0, 60)}</option>)}
                </select>
              </div>
            ) : (
              <p className="text-xs text-graphite">Attach a full text to a source on the <Link href={`/app/projects/${projectId}/literature`}>Library</Link> tab first.</p>
            ),
          )}
          {agentCard(
            "supervisor-feedback",
            reviewed.length ? (
              <div className="field">
                <label htmlFor="ai-review">Submission with feedback</label>
                <select id="ai-review" name="reviewRequestId" className="input" required>
                  {reviewed.map((x) => <option key={x.r.id} value={x.r.id}>{x.title} · round {x.r.round}</option>)}
                </select>
              </div>
            ) : (
              <p className="text-xs text-graphite">Available once a supervisor has given feedback on a submission.</p>
            ),
          )}
          {agentCard("literature-review", <Field id="ai-focus" label="Focus (optional)" name="focus" maxLength={500} placeholder="e.g. effects on women's savings" />)}
        </div>
      </Section>

      <Section title="Recent runs">
        {runs.length === 0 && <p className="text-sm text-graphite">Nothing yet.</p>}
        <ul className="grid gap-3">
          {runs.map((r) => (
            <li key={r.id} className="rounded-md border border-rule bg-sheet p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-semibold">
                  {AGENTS[r.agentKey]?.title ?? r.agentKey} <span className="font-normal text-graphite">· {formatDateTime(r.createdAt)} · {r.modelId}</span>
                </p>
                <span className="flex items-center gap-2">
                  <Tag tone={STATUS_TONE[r.status]!}>{r.status}</Tag>
                  {(r.status === "queued" || r.status === "running") && r.userId === uid && (
                    <ActionForm action={aiRunControlAction} submitLabel="Cancel" variant="quiet" className="flex">
                      {hidden}
                      <input type="hidden" name="intent" value="cancel" />
                      <input type="hidden" name="runId" value={r.id} />
                    </ActionForm>
                  )}
                </span>
              </div>
              {"question" in r.input && <p className="mt-2 text-graphite">Q: {String(r.input.question)}</p>}
              {r.output && "answer" in r.output && <p className="mt-2 whitespace-pre-line">{String(r.output.answer)}</p>}
              {r.output && "proposalId" in r.output && (
                <p className="mt-2">
                  Proposed a schedule with {String(r.output.items)} items. <Link href={`/app/projects/${projectId}/schedule`}>Review it on the Schedule tab</Link>.
                </p>
              )}
              {r.output && "draft" in r.output && (
                <div className="mt-3 rounded border border-rule-soft bg-paper p-3">
                  <p className="mb-2 text-xs text-graphite">Draft — every citation was checked against your library ({(r.output.citedKeys as string[]).map((k) => `@${k}`).join(", ") || "none cited"}). Review it before using it.</p>
                  <div className="font-serif text-[0.9375rem] whitespace-pre-line">{String(r.output.draft)}</div>
                  {(r.output.gaps as string[]).length > 0 && (
                    <>
                      <p className="mt-3 text-sm font-semibold">Gaps</p>
                      <ul className="list-disc pl-5 text-sm">{(r.output.gaps as string[]).map((g, i) => <li key={i}>{g}</li>)}</ul>
                    </>
                  )}
                </div>
              )}
              {r.output && "discardedNotFoundInDocument" in r.output && Number(r.output.discardedNotFoundInDocument) > 0 && (
                <p className="mt-2 text-xs text-graphite">{String(r.output.discardedNotFoundInDocument)} suggested quote(s) were discarded because they do not appear in the document.</p>
              )}
              {r.error && <p className="mt-2 text-margin">{r.error}</p>}
              {r.toolCalls.length > 0 && <p className="mt-2 text-xs text-graphite">Looked up: {[...new Set(r.toolCalls.map((t) => t.tool.replace(/_/g, " ")))].join(", ")}</p>}
              {r.suggestions.length > 0 && (
                <ul className="mt-3 grid gap-2">
                  {r.suggestions.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 rounded border border-rule-soft bg-paper px-3 py-2">
                      <span className="min-w-0">
                        <span className="text-xs font-semibold text-graphite">{KIND_LABEL[s.kind]} </span>
                        {describe(s.kind, s.payload)}
                        {"rationale" in s.payload && s.payload.rationale ? <span className="block text-xs text-graphite">Why: {String(s.payload.rationale)}</span> : null}
                      </span>
                      {s.status === "pending" ? (
                        <span className="flex gap-2">
                          {(["accept", "dismiss"] as const).map((d) => (
                            <ActionForm key={d} action={aiRunControlAction} submitLabel={d === "accept" ? "Add" : "Dismiss"} variant={d === "accept" ? "primary" : "quiet"} className="flex">
                              {hidden}
                              <input type="hidden" name="intent" value={d} />
                              <input type="hidden" name="suggestionId" value={s.id} />
                            </ActionForm>
                          ))}
                        </span>
                      ) : (
                        <Tag tone={s.status === "accepted" ? "done" : "cancelled"}>{s.status}</Tag>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {r.status === "succeeded" && (r.funding === "platform" ? (
                <p className="mt-2 text-xs text-graphite">{r.inputTokens + r.outputTokens} tokens on ResearchMate credit · charged {formatUsd(r.customerChargeMicros)}.</p>
              ) : (
                <p className="mt-2 text-xs text-graphite">{r.inputTokens + r.outputTokens} tokens on your own key{r.providerCostMicros != null ? ` (≈ ${formatUsd(r.providerCostMicros)} at the provider's price)` : ""}. Not charged by ResearchMate.</p>
              ))}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
