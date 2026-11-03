import { htmlToRuns } from "@researchmate/citations";
import type { Assembled, Inline, NumberedBlock } from "@researchmate/documents";
import { clusterFallback, isEmptyOptional, texToText } from "@researchmate/documents";
import { Fragment, type ReactNode } from "react";

/** Citeproc HTML → React, via formatting runs (never injected as HTML). */
function CslText({ html }: { html: string }) {
  return (
    <>
      {htmlToRuns(html.replace(/<div class="csl-left-margin">([\s\S]*?)<\/div>/g, "$1 ")).map((r, i) => {
        let n: ReactNode = r.text;
        if (r.italics) n = <i>{n}</i>;
        if (r.bold) n = <b>{n}</b>;
        if (r.superScript) n = <sup>{n}</sup>;
        return <Fragment key={i}>{n}</Fragment>;
      })}
    </>
  );
}

function Inlines({ inl, model }: { inl: Inline[]; model: Assembled }) {
  return (
    <>
      {inl.map((x, i) => {
        if (x.t === "cite") {
          const c = model.clusters[x.cluster]!;
          const html = model.citationText.get(c.id);
          return html ? <CslText key={i} html={html} /> : <mark key={i} className="bg-margin-wash text-margin" title="Not in the library">{clusterFallback(c)}</mark>;
        }
        let n: ReactNode = x.v;
        if (x.code) n = <code>{n}</code>;
        if (x.i) n = <i>{n}</i>;
        if (x.b) n = <b>{n}</b>;
        return <Fragment key={i}>{n}</Fragment>;
      })}
    </>
  );
}

function Blocks({ blocks, model, figureUrl }: { blocks: NumberedBlock[]; model: Assembled; figureUrl: (id: string) => string }) {
  let list = 0;
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return <p key={i} className="my-2"><Inlines inl={b.inl} model={model} /></p>;
          case "h": {
            const label = b.number ? (b.number.startsWith("Appendix") ? `${b.number}: ` : `${b.number} `) : "";
            return b.level === 2 ? <h3 key={i} className="mt-5 mb-2 font-sans text-lg font-semibold">{label}<Inlines inl={b.inl} model={model} /></h3> : <h4 key={i} className="mt-4 mb-1 font-sans font-semibold italic">{label}<Inlines inl={b.inl} model={model} /></h4>;
          }
          case "quote":
            return <blockquote key={i} className="my-3 ml-8 border-l-2 border-rule pl-3"><Inlines inl={b.inl} model={model} /></blockquote>;
          case "list": {
            const items = b.items.map((it, k) => <li key={k}><Inlines inl={it} model={model} /></li>);
            list++;
            return b.ordered ? <ol key={`${i}-${list}`} className="my-2 list-decimal pl-8">{items}</ol> : <ul key={`${i}-${list}`} className="my-2 list-disc pl-8">{items}</ul>;
          }
          case "table":
            return (
              <figure key={i} className="my-4 overflow-x-auto">
                <figcaption className="mb-1 text-sm"><b>Table {b.number}</b>{b.caption.length ? ". " : ""}<Inlines inl={b.caption} model={model} /></figcaption>
                <table className="w-full border-collapse text-sm">
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {r.map((c, ci) => {
                          const Cell = b.header && ri === 0 ? "th" : "td";
                          return <Cell key={ci} className="border border-rule px-2 py-1 text-left align-top"><Inlines inl={c} model={model} /></Cell>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </figure>
            );
          case "figure":
            return (
              <figure key={i} className="my-4 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={figureUrl(b.fileId)} alt={b.caption.map((x) => (x.t === "text" ? x.v : "")).join("")} className="mx-auto max-h-96 max-w-full" />
                <figcaption className="mt-1 text-sm"><b>Figure {b.number}</b>{b.caption.length ? ". " : ""}<Inlines inl={b.caption} model={model} /></figcaption>
              </figure>
            );
          case "eq":
            return (
              <p key={i} className="my-3 flex items-center">
                <span className="flex-1 text-center italic">{texToText(b.tex)}</span>
                <span>({b.number})</span>
              </p>
            );
          case "break":
            return <hr key={i} className="my-6 border-dashed border-rule" aria-label="Page break" />;
        }
      })}
    </>
  );
}

/** Reading view of the assembled document; mirrors the DOCX structure (not its exact pagination). */
export function DocPreview({ model, title, meta, figureUrl }: { model: Assembled; title: string; meta: Record<string, string>; figureUrl: (id: string) => string }) {
  return (
    <article className="mx-auto max-w-[44rem] rounded-md border border-rule bg-white px-6 py-8 font-serif text-[1rem] leading-relaxed text-ink shadow-sm sm:px-12">
      {model.sections.map((s) => {
        if (isEmptyOptional(s)) return null;
        const k = s.section.kind;
        if (k === "title")
          return (
            <header key={s.section.id} className="mb-10 text-center">
              <h2 className="text-2xl font-bold">{title}</h2>
              {meta.subtitle && <p className="mt-1">{meta.subtitle}</p>}
              {meta.author && <p className="mt-4">{meta.author}</p>}
              {meta.degree && <p className="mt-3 text-sm italic">{meta.degree}</p>}
              {(meta.department || meta.institution) && <p className="text-sm">{[meta.department, meta.institution].filter(Boolean).join(", ")}</p>}
            </header>
          );
        if (k === "toc")
          return (
            <nav key={s.section.id} className="mb-8" aria-label="Contents">
              <h2 className="mb-2 text-center font-sans text-xl font-bold">{s.heading}</h2>
              <ol className="text-sm">
                {model.headings.filter((h) => h.level < 3).map((h, i) => <li key={i} className={h.level === 2 ? "pl-6" : ""}>{h.text}</li>)}
              </ol>
            </nav>
          );
        if (k === "references")
          return model.bibliography.length ? (
            <section key={s.section.id} className="mt-8">
              <h2 className="mb-3 font-sans text-xl font-bold">{s.heading}</h2>
              {model.bibliography.map((b, i) => <p key={i} className="mb-2 pl-8 -indent-8"><CslText html={b} /></p>)}
            </section>
          ) : null;
        return (
          <section key={s.section.id} className="mt-8">
            <h2 className={`mb-2 font-sans text-xl font-bold ${k === "front" ? "text-center" : ""}`}>{s.heading}</h2>
            <Blocks blocks={s.blocks} model={model} figureUrl={figureUrl} />
          </section>
        );
      })}
    </article>
  );
}
