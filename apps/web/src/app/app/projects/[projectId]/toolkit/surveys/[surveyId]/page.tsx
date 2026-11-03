import { isAppError } from "@researchmate/shared";
import { notFound } from "next/navigation";
import { SurveyEditor } from "@/components/survey-editor";
import { toolkitService } from "@/server/services";
import { loadToolkit } from "@/server/toolkit";

export const metadata = { title: "Questionnaire" };

export default async function SurveyPage({ params }: { params: Promise<{ projectId: string; surveyId: string }> }) {
  const { projectId, surveyId } = await params;
  const v = await loadToolkit(projectId);
  if (!/^[0-9a-f-]{36}$/i.test(surveyId)) notFound();
  const s = await (await toolkitService()).survey(v.session.user.id, surveyId).catch((e) => (isAppError(e) && e.code === "NOT_FOUND" ? null : Promise.reject(e)));
  if (!s || s.projectId !== projectId) notFound();
  const q = `?id=${s.id}`;
  return (
    <>
      <p className="mb-6 flex flex-wrap gap-4 text-sm">
        <a href={`/api/projects/${projectId}/toolkit/survey-docx${q}`}>Download questionnaire (Word)</a>
        <a href={`/api/projects/${projectId}/toolkit/codebook${q}`}>Download codebook and data-entry sheet (Excel)</a>
        <span className="text-graphite">Exports use the last saved version.</span>
      </p>
      <SurveyEditor projectId={projectId} survey={{ id: s.id, title: s.title, introduction: s.introduction, consent: s.consent, questions: s.questions, revision: s.revision }} canEdit={v.canEdit} />
    </>
  );
}
