import { DIAGRAM_TEMPLATES } from "@researchmate/toolkit";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { EmptyState, Section } from "@/components/ui";
import { toolkitAction } from "@/server/actions/toolkit";
import { toolkitService } from "@/server/services";
import { loadToolkit } from "@/server/toolkit";

export const metadata = { title: "Diagrams" };

export default async function DiagramsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const v = await loadToolkit(projectId);
  const list = await (await toolkitService()).listDiagrams(v.session.user.id, projectId);
  return (
    <>
      <Section title="Diagrams" description="Conceptual frameworks, methodology flowcharts, theories of change and more, drawn from editable Mermaid text. Export as SVG or PNG, or print to PDF.">
        {list.length === 0 ? (
          <EmptyState title="No diagrams yet" body="Start from a template below." />
        ) : (
          <ul className="grid gap-2">
            {list.map((d) => (
              <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-rule bg-sheet px-4 py-3 text-sm">
                <Link href={`/app/projects/${projectId}/toolkit/diagrams/${d.id}`} className="font-semibold">{d.title}</Link>
                <span className="text-graphite">{DIAGRAM_TEMPLATES[d.kind]?.title ?? d.kind} · revision {d.revision} · updated {d.updatedAt.toISOString().slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {v.canEdit && (
        <Section title="New diagram">
          <ActionForm action={toolkitAction} submitLabel="Create diagram" className="grid max-w-xl gap-3">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="intent" value="diagram_create" />
            <div className="field">
              <label htmlFor="dg-template">Type</label>
              <select id="dg-template" name="template" className="input">
                {Object.entries(DIAGRAM_TEMPLATES).map(([k, t]) => (
                  <option key={k} value={k}>{t.title}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="dg-new-title">Title (optional)</label>
              <input id="dg-new-title" name="title" className="input" maxLength={200} />
            </div>
          </ActionForm>
        </Section>
      )}
    </>
  );
}
