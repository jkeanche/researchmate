import { LiteratureNav } from "@/components/literature-nav";
import { PlanNotice } from "@/components/plan-ui";
import { loadLiterature } from "@/server/literature";

export default async function LiteratureLayout({ children, params }: { children: React.ReactNode; params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const v = await loadLiterature(projectId);
  return (
    <>
      <LiteratureNav projectId={projectId} />
      {!v.toolkit && (
        <div className="mb-6">
          <PlanNotice>The reference manager and literature tools are not included in the {v.planName} plan. Existing entries stay readable.</PlanNotice>
        </div>
      )}
      {children}
    </>
  );
}
