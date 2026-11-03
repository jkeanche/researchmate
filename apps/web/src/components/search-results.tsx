import { SEARCH_KINDS, type SearchHit } from "@researchmate/research";
import Link from "next/link";

/** Splits a «highlighted» snippet into text and <mark> parts. Content is rendered as text, never HTML. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith("«") && p.endsWith("»") ? <mark key={i} className="rounded-sm bg-[#fff1b8] px-0.5 text-ink">{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

export function SearchForm({ q, label }: { q: string; label: string }) {
  return (
    <form role="search" className="mb-6 flex max-w-2xl gap-2">
      <label htmlFor="search-q" className="sr-only">{label}</label>
      <input id="search-q" name="q" className="input flex-1" defaultValue={q} placeholder="e.g. savings, “mobile money”, interview -pilot" minLength={2} maxLength={200} required />
      <button className="btn btn-primary" type="submit">Search</button>
    </form>
  );
}

export function SearchResults({ hits, showProject, q }: { hits: SearchHit[]; showProject: boolean; q: string }) {
  if (!q) return <p className="text-sm text-graphite">Search references, evidence, file text, document sections, tasks and comments, feedback, research questions, risks and events. Use quotes for phrases, OR for alternatives and - to exclude a word.</p>;
  if (!hits.length) return <p className="text-sm text-graphite">Nothing matched “{q}”.</p>;
  return (
    <ol className="grid gap-3" aria-label="Search results">
      {hits.map((h) => (
        <li key={`${h.kind}:${h.id}`} className="rounded-md border border-rule bg-sheet p-4 text-sm">
          <p className="text-xs tracking-wide text-graphite uppercase">
            {SEARCH_KINDS[h.kind]}
            {showProject ? ` · ${h.projectTitle}` : ""}
          </p>
          <p className="mt-1 font-semibold">
            <Link href={h.link}>{h.title}</Link>
          </p>
          {h.snippet && <p className="mt-1 text-graphite"><Snippet text={h.snippet} /></p>}
        </li>
      ))}
    </ol>
  );
}
