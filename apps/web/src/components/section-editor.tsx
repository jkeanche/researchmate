"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { saveSectionAction } from "@/server/actions/documents";

export interface EditorRef {
  key: string;
  title: string;
  year: number | null;
}

/** Same rule as the server: running text only (no tables, figures, equations or citations). */
function countWords(src: string): number {
  let n = 0;
  let inEq = false;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (line === "$$") {
      inEq = !inEq;
      continue;
    }
    if (inEq || !line || line.startsWith("|") || line.startsWith("$$") || line.startsWith("![") || /^Table:/i.test(line) || line === "\\newpage") continue;
    const text = line.replace(/\[[^\]]*@[^\]]*\]/g, " ").replace(/^(#{1,3}|[-*•]|\d+[.)]|>)\s+/, "").replace(/[*`]/g, "");
    n += text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }
  return n;
}

export function SectionEditor({
  sectionId,
  initialContent,
  initialVersion,
  wordLimit,
  canEdit,
  refs,
  images,
  quotes,
}: {
  sectionId: string;
  initialContent: string;
  initialVersion: number;
  wordLimit: number | null;
  canEdit: boolean;
  refs: EditorRef[];
  images: { id: string; name: string }[];
  quotes: { key: string | null; page: number | null; passage: string }[];
}) {
  const router = useRouter();
  const [content, setContent] = useState(initialContent);
  const [saved, setSaved] = useState(initialContent);
  const [version, setVersion] = useState(initialVersion);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "saved" | "error"; text: string }>({ kind: "idle", text: "" });
  const [cite, setCite] = useState("");
  const [locator, setLocator] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = content !== saved;
  const words = countWords(content);

  const save = useCallback(async () => {
    if (!canEdit || content === saved || status.kind === "saving") return;
    setStatus({ kind: "saving", text: "Saving…" });
    const snapshot = content;
    const r = await saveSectionAction({ sectionId, content: snapshot, version });
    if (r.ok) {
      setSaved(snapshot);
      setVersion(r.version);
      setStatus({ kind: "saved", text: `Saved ${new Date(r.savedAt).toLocaleTimeString()}` });
      router.refresh();
    } else setStatus({ kind: "error", text: r.error });
  }, [canEdit, content, saved, sectionId, version, status.kind, router]);

  // Switching to another section (client navigation) saves unsaved text on the way out.
  const latest = useRef({ content, saved, version });
  latest.current = { content, saved, version };
  useEffect(
    () => () => {
      const l = latest.current;
      if (canEdit && l.content !== l.saved) void saveSectionAction({ sectionId, content: l.content, version: l.version });
    },
    [sectionId, canEdit],
  );

  // Autosave after 20 s of unsaved changes; warn before leaving with unsaved text.
  useEffect(() => {
    if (!dirty || status.kind === "error") return;
    const t = setTimeout(save, 20_000);
    return () => clearTimeout(t);
  }, [dirty, save, status.kind]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const insert = (before: string, after = "", block = false) => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    const sel = content.slice(a, b);
    const pre = block && a > 0 && content[a - 1] !== "\n" ? "\n\n" : "";
    const text = `${pre}${before}${sel}${after}`;
    const next = content.slice(0, a) + text + content.slice(b);
    setContent(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = a + pre.length + before.length + sel.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const tool = (label: string, onClick: () => void, title?: string) => (
    <button type="button" className="rounded border border-rule bg-sheet px-2 py-1 text-xs hover:border-ink" onClick={onClick} title={title ?? label} disabled={!canEdit}>
      {label}
    </button>
  );

  return (
    <div className="grid gap-2">
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Formatting">
          {tool("B", () => insert("**", "**"), "Bold")}
          {tool("I", () => insert("*", "*"), "Italic")}
          {tool("Heading", () => insert("## ", "", true))}
          {tool("Sub-heading", () => insert("### ", "", true))}
          {tool("• List", () => insert("- ", "", true), "Bulleted list")}
          {tool("1. List", () => insert("1. ", "", true), "Numbered list")}
          {tool("Quote", () => insert("> ", "", true), "Block quotation")}
          {tool("Table", () => insert("Table: Caption\n| Column 1 | Column 2 |\n|---|---|\n| | |\n", "", true))}
          {tool("Equation", () => insert("$$ ", " $$\n", true))}
          {tool("Page break", () => insert("\\newpage\n", "", true))}
          {images.length > 0 && (
            <select aria-label="Insert figure" className="input h-7 w-auto py-0 text-xs" value="" onChange={(e) => e.target.value && insert(`![Caption](file:${e.target.value})\n`, "", true)}>
              <option value="">Figure…</option>
              {images.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
        </div>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <div className="field min-w-56 flex-1">
            <label htmlFor={`cite-${sectionId}`}>Cite a source</label>
            <select id={`cite-${sectionId}`} className="input" value={cite} onChange={(e) => setCite(e.target.value)}>
              <option value="">{refs.length ? "Choose from the library…" : "The library is empty"}</option>
              {refs.map((r) => <option key={r.key} value={r.key}>@{r.key} — {r.title.slice(0, 70)}{r.year ? ` (${r.year})` : ""}</option>)}
            </select>
          </div>
          <div className="field w-28">
            <label htmlFor={`loc-${sectionId}`}>Page</label>
            <input id={`loc-${sectionId}`} className="input" value={locator} onChange={(e) => setLocator(e.target.value)} placeholder="e.g. 12" maxLength={20} />
          </div>
          <button type="button" className="btn btn-quiet" disabled={!cite} onClick={() => (insert(`[@${cite}${locator.trim() ? `, p. ${locator.trim()}` : ""}]`), setLocator(""))}>
            Insert citation
          </button>
        </div>
      )}
      <label htmlFor={`text-${sectionId}`} className="sr-only">Section text</label>
      <textarea
        id={`text-${sectionId}`}
        ref={area}
        className="input min-h-[28rem] font-mono text-[0.875rem] leading-relaxed"
        value={content}
        readOnly={!canEdit}
        onChange={(e) => {
          setContent(e.target.value);
          if (status.kind !== "saving") setStatus({ kind: "idle", text: "" });
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault();
            void save();
          }
        }}
        spellCheck
      />
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className={wordLimit && words > wordLimit ? "font-semibold text-margin" : "text-graphite"} aria-live="polite">
          {words.toLocaleString("en")} words{wordLimit ? ` of ${wordLimit.toLocaleString("en")}` : ""}
        </span>
        <span className="flex items-center gap-3">
          <span role="status" className={status.kind === "error" ? "text-margin" : "text-graphite"}>
            {status.text || (dirty ? "Unsaved changes" : "")}
          </span>
          {canEdit && (
            <button type="button" className="btn btn-primary" onClick={save} disabled={!dirty || status.kind === "saving"}>
              {status.kind === "saving" ? "Saving…" : "Save"}
            </button>
          )}
        </span>
      </div>
      {quotes.length > 0 && canEdit && (
        <details className="text-sm">
          <summary className="cursor-pointer text-graphite">Linked evidence ({quotes.length}) — insert a quotation</summary>
          <ul className="mt-2 grid gap-2">
            {quotes.map((q, i) => (
              <li key={i} className="flex items-start justify-between gap-2 rounded border border-rule-soft bg-paper p-2">
                <span>“{q.passage}” {q.key && <code className="text-xs">[@{q.key}{q.page ? `, p. ${q.page}` : ""}]</code>}</span>
                <button type="button" className="btn btn-quiet shrink-0" onClick={() => insert(`“${q.passage}”${q.key ? ` [@${q.key}${q.page ? `, p. ${q.page}` : ""}]` : ""}`)}>Insert</button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="text-xs text-graphite">
        <summary className="cursor-pointer">Formatting help</summary>
        <pre className="mt-2 overflow-x-auto rounded bg-rule-soft p-3 whitespace-pre-wrap">{`## Heading   ### Sub-heading   **bold**   *italic*
Citations: [@key]  [@key, p. 12]  [see @a; @b]  [-@key] (year only)
- bullet   1. numbered   > quotation
Table: Caption
| A | B |
|---|---|
| 1 | 2 |
![Caption](file:<id>)  — use the Figure menu
$$ y = \\beta x + \\epsilon $$   \\newpage`}</pre>
      </details>
    </div>
  );
}
