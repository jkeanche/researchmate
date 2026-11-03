import { isAppError } from "@researchmate/shared";
import { Fragment } from "react";
import { Notice } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { loadLiterature } from "@/server/literature";
import { literatureService } from "@/server/services";

export const metadata = { title: "Search documents" };

/** ts_headline marks matches with « »; render them as <mark> without trusting any HTML. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/(«[^»]*»)/).map((part, i) =>
        part.startsWith("«") ? <mark key={i} className="bg-amber-wash px-0.5">{part.slice(1, -1)}</mark> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}

export default async function PassagesPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ q?: string }> }) {
  const { projectId } = await params;
  const q = ((await searchParams).q ?? "").slice(0, 300);
  const v = await loadLiterature(projectId);
  let hits: Awaited<ReturnType<ReturnType<typeof literatureService>["searchPassages"]>> = [];
  let error = "";
  if (q.trim().length >= 2) {
    try {
      hits = await literatureService().searchPassages(v.session.user.id, projectId, q);
    } catch (err) {
      error = isAppError(err) ? err.message : "The search failed.";
    }
  }
  return (
    <Section title="Search inside project documents" description="Searches the text extracted from PDFs, Word files and text files uploaded to this project (scanned PDFs are read with OCR). Results show the file and page.">
      <form className="mb-4 flex max-w-2xl flex-wrap items-end gap-2" role="search">
        <div className="field min-w-64 flex-1">
          <label htmlFor="p-q">Words or phrase</label>
          <input id="p-q" name="q" className="input" defaultValue={q} required minLength={2} placeholder='e.g. "household savings" attrition' />
        </div>
        <button className="btn btn-primary" type="submit">Search</button>
      </form>
      {error && <p role="alert" className="text-sm text-margin">{error}</p>}
      {q && !error && hits.length === 0 && <Notice>No matches. Files are searchable once processing has finished; files with AI processing turned off are not indexed.</Notice>}
      <ul className="grid gap-3">
        {hits.map((h, i) => (
          <li key={i} className="rounded-md border border-rule bg-sheet p-4 text-sm">
            <p className="font-semibold">
              <a href={`/api/files/${h.fileId}/download`}>{h.fileName}</a>
              <span className="font-normal text-graphite">{h.page ? ` · page ${h.page}` : ""}{h.method === "ocr" ? " · read by OCR" : ""}</span>
            </p>
            <p className="mt-1 font-serif text-[0.9375rem]"><Snippet text={h.snippet} /></p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
