import { DECK_KINDS } from "@researchmate/toolkit";
import { PlanNotice } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { loadToolkit } from "@/server/toolkit";

export const metadata = { title: "Presentations and reports" };

const ABOUT: Record<string, string> = {
  proposal: "Title, background, objectives, research questions, methodology, timeline and risks.",
  progress: "Progress figures, stages, overdue work, next steps and open risks.",
  defense: "Background, objectives, questions and methodology, with slides for findings, contributions and limitations for you to complete.",
};

export default async function OutputsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const v = await loadToolkit(projectId);
  const base = `/api/projects/${projectId}/toolkit`;
  return (
    <>
      <Section title="Presentations" description="PowerPoint decks built from what is recorded in the project: its description, plan, schedule and risks. Sections with nothing recorded get a placeholder slide rather than invented content.">
        {!v.advanced ? (
          <PlanNotice>Generated presentations and reports are not included in the {v.planName} plan.</PlanNotice>
        ) : (
          <ul className="grid gap-3">
            {Object.entries(DECK_KINDS).map(([k, label]) => (
              <li key={k} className="rounded-md border border-rule bg-sheet p-4 text-sm">
                <a href={`${base}/deck-${k}`} className="font-semibold">{label} (.pptx)</a>
                <p className="mt-1 text-graphite">{ABOUT[k]}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {v.advanced && (
        <Section title="Reports">
          <ul className="grid gap-3">
            <li className="rounded-md border border-rule bg-sheet p-4 text-sm">
              <a href={`${base}/status-report`} className="font-semibold">Status report (.docx)</a>
              <p className="mt-1 text-graphite">Progress summary, stages, milestones, overdue tasks, next steps, open risks and supervisor reviews, as of today.</p>
            </li>
          </ul>
        </Section>
      )}
    </>
  );
}
