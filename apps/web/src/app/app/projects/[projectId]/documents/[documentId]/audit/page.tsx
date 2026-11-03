import Link from "next/link";
import { Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { loadDocument } from "@/server/documents";
import { ACCESS_LABELS, VERIFICATION_LABELS, VERIFICATION_TONE } from "@/server/literature";
import { documentService } from "@/server/services";

export const metadata = { title: "Checks and citations" };

const TONE = { pass: "done", warn: "awaiting_approval", fail: "blocked" } as const;
const LABEL = { pass: "Pass", warn: "Check", fail: "Fails" } as const;

export default async function AuditPage({ params }: { params: Promise<{ projectId: string; documentId: string }> }) {
  const { projectId, documentId } = await params;
  const d = await loadDocument(projectId, documentId);
  const docs = await documentService();
  const [{ checks }, audit] = await Promise.all([docs.preview(d.session.user.id, documentId), docs.audit(d.session.user.id, documentId)]);
  const lit = `/app/projects/${projectId}/literature`;
  return (
    <>
      <Section title="Content checks" description="Checked continuously against the specification. Layout checks (pages, margins, numbering) run on each PDF export; see Versions & export.">
        <ul className="grid gap-2">
          {checks.map((c) => (
            <li key={c.key} className="flex flex-wrap items-start gap-3 rounded-md border border-rule bg-sheet px-3 py-2 text-sm">
              <Tag tone={TONE[c.status]}>{LABEL[c.status]}</Tag>
              <span><span className="font-semibold">{c.label}.</span> {c.detail}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={`Citation audit (${audit.total} citations, ${audit.citations.length} sources)`} description="Every citation must point to a source in the project library. Sources are flagged when their details haven't been verified or only their bibliographic details are on file.">
        {audit.unknown.length > 0 && (
          <p role="alert" className="mb-3 rounded-md border border-margin/30 bg-margin-wash px-3 py-2 text-sm text-margin">
            Not in the library: {audit.unknown.map((c) => `@${c.key} (${c.sections.join(", ")})`).join("; ")}. Export is blocked until these are added to the <Link href={lit}>library</Link> or corrected.
          </p>
        )}
        {audit.citations.length === 0 ? (
          <p className="text-sm text-graphite">No citations yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <caption className="sr-only">Cited sources</caption>
              <thead>
                <tr className="border-b border-rule">
                  <th scope="col" className="py-2 pr-3">Source</th>
                  <th scope="col" className="py-2 pr-3">Cited in</th>
                  <th scope="col" className="py-2 pr-3">Times</th>
                  <th scope="col" className="py-2 pr-3">Content held</th>
                  <th scope="col" className="py-2">Verification</th>
                </tr>
              </thead>
              <tbody>
                {audit.citations.map((c) => (
                  <tr key={c.key} className="border-b border-rule-soft align-top">
                    <td className="py-2 pr-3"><code className="text-xs">@{c.key}</code><br />{c.title ?? <span className="text-margin">Not in the library</span>}</td>
                    <td className="py-2 pr-3">{c.sections.join(", ")}</td>
                    <td className="py-2 pr-3 tabular-nums">{c.count}</td>
                    <td className="py-2 pr-3">{c.access ? ACCESS_LABELS[c.access] : "—"}</td>
                    <td className="py-2">{c.status ? <Tag tone={VERIFICATION_TONE[c.status]!}>{VERIFICATION_LABELS[c.status]}</Tag> : <Tag tone="blocked">Missing</Tag>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {audit.metadataOnly.length > 0 && <p className="mt-3 text-sm text-graphite">Cited with only bibliographic details on file (no abstract or full text): {audit.metadataOnly.map((c) => `@${c.key}`).join(", ")}. Make sure you have read these sources.</p>}
      </Section>

      {audit.uncitedEvidence.length > 0 && (
        <Section title="Linked evidence not cited" description="Evidence linked to a section whose source isn't cited in that section.">
          <ul className="grid gap-2 text-sm">
            {audit.uncitedEvidence.map((e, i) => <li key={i} className="rounded-md border border-amber/30 bg-amber-wash px-3 py-2">{e.section}: “{e.claim || "evidence"}” — cite <code>[@{e.key}]</code></li>)}
          </ul>
        </Section>
      )}

      <Section title={`Library sources not cited (${audit.uncited.length})`}>
        {audit.uncited.length === 0 ? <p className="text-sm text-graphite">Every library source is cited.</p> : <p className="text-sm text-graphite">{audit.uncited.map((r) => `@${r.key}`).join(", ")}. Uncited sources don't appear in the reference list.</p>}
      </Section>
    </>
  );
}
