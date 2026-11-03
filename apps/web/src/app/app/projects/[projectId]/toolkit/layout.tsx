import { PlanNotice } from "@/components/plan-ui";
import { ToolkitNav } from "@/components/toolkit-nav";
import { loadToolkit } from "@/server/toolkit";

export default async function ToolkitLayout({ children, params }: { children: React.ReactNode; params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const v = await loadToolkit(projectId);
  return (
    <>
      <ToolkitNav projectId={projectId} />
      {!v.basic && (
        <div className="mb-6">
          <PlanNotice>The research toolkit is not included in the {v.planName} plan. Anything already created stays readable.</PlanNotice>
        </div>
      )}
      {children}
    </>
  );
}
