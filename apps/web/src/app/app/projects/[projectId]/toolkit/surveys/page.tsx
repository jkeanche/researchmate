import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { EmptyState, Section } from "@/components/ui";
import { toolkitAction } from "@/server/actions/toolkit";
import { toolkitService } from "@/server/services";
import { loadToolkit } from "@/server/toolkit";

export const metadata = { title: "Questionnaires" };

export default async function SurveysPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const v = await loadToolkit(projectId);
  const list = await (await toolkitService()).listSurveys(v.session.user.id, projectId);
  return (
    <>
      <Section title="Questionnaires" description="Design a questionnaire with consent text, closed and open questions and Likert scales, then export it as a Word document and an Excel codebook with a matching data-entry sheet. Responses are collected outside ResearchMate.">
        {list.length === 0 ? (
          <EmptyState title="No questionnaires yet" body="Create one below." />
        ) : (
          <ul className="grid gap-2">
            {list.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-rule bg-sheet px-4 py-3 text-sm">
                <Link href={`/app/projects/${projectId}/toolkit/surveys/${s.id}`} className="font-semibold">{s.title}</Link>
                <span className="text-graphite">{s.questions.length} question{s.questions.length === 1 ? "" : "s"} · updated {s.updatedAt.toISOString().slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {v.canEdit && (
        <Section title="New questionnaire">
          <ActionForm action={toolkitAction} submitLabel="Create questionnaire" className="grid max-w-xl gap-3">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="intent" value="survey_create" />
            <div className="field">
              <label htmlFor="sv-new-title">Title</label>
              <input id="sv-new-title" name="title" className="input" required minLength={2} maxLength={200} />
            </div>
          </ActionForm>
        </Section>
      )}
    </>
  );
}
