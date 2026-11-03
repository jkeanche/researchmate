"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { saveDiagramAction } from "@/server/actions/toolkit";

type Mermaid = typeof import("mermaid").default;
let mermaidPromise: Promise<Mermaid> | null = null;
function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      // strict: no click handlers or scripts in labels; HTML in labels is sanitised.
      securityLevel: "strict",
      theme: "neutral",
      fontFamily: "inherit",
      // SVG text labels (no foreignObject) so PNG export doesn't taint the canvas.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    return m.default;
  });
  return mermaidPromise;
}

let seq = 0;

/** Renders Mermaid source to SVG with Mermaid's strict security level. */
export function MermaidView({ source, onSvg }: { source: string; onSvg?: (svg: string) => void }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const m = await loadMermaid();
        await m.parse(source);
        const { svg } = await m.render(`mmd-${++seq}`, source);
        if (!live) return;
        setSvg(svg);
        setError("");
        onSvg?.(svg);
      } catch (e) {
        if (live) setError((e as Error).message?.split("\n").slice(0, 3).join(" ") || "The diagram could not be drawn.");
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [source, onSvg]);
  return (
    <div>
      {error && <p role="status" className="mb-2 rounded-md border border-margin/30 bg-margin-wash px-3 py-2 text-xs text-margin">Syntax problem: {error}</p>}
      {/* Mermaid output under securityLevel "strict" is sanitised (DOMPurify) before it is returned. */}
      <div className="diagram-canvas overflow-auto rounded-md border border-rule bg-white p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" data-testid="diagram-render" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function DiagramEditor({ projectId, diagram, canEdit }: { projectId: string; diagram: { id: string; title: string; source: string; revision: number }; canEdit: boolean }) {
  const [title, setTitle] = useState(diagram.title);
  const [source, setSource] = useState(diagram.source);
  const [revision, setRevision] = useState(diagram.revision);
  const [status, setStatus] = useState<{ ok?: string; error?: string }>({});
  const [saving, setSaving] = useState(false);
  const svgRef = useRef("");
  const onSvg = useCallback((s: string) => void (svgRef.current = s), []);
  const dirty = title !== diagram.title || source !== diagram.source;
  const file = (title || "diagram").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "diagram";

  async function save() {
    setSaving(true);
    const r = await saveDiagramAction({ projectId, diagramId: diagram.id, title, source, revision });
    setSaving(false);
    if (r.error) return setStatus({ error: r.error });
    setRevision(Number(r.data?.revision ?? revision + 1));
    diagram.title = title;
    diagram.source = source;
    setStatus({ ok: "Saved." });
  }

  function exportSvg() {
    if (svgRef.current) download(`${file}.svg`, new Blob([svgRef.current], { type: "image/svg+xml" }));
  }

  function exportPng() {
    const svg = svgRef.current;
    if (!svg) return;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      const scale = 2;
      const w = img.naturalWidth || 1200;
      const h = img.naturalHeight || 800;
      const c = document.createElement("canvas");
      c.width = w * scale;
      c.height = h * scale;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => b && download(`${file}.png`, b), "image/png");
    };
    img.src = url;
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="no-print grid content-start gap-3">
          <div className="field">
            <label htmlFor="dg-title">Title</label>
            <input id="dg-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} readOnly={!canEdit} />
          </div>
          <div className="field">
            <label htmlFor="dg-source">Mermaid source</label>
            <textarea id="dg-source" className="input min-h-80 font-mono text-xs" value={source} onChange={(e) => setSource(e.target.value)} spellCheck={false} readOnly={!canEdit} maxLength={50000} />
          </div>
          <p className="text-xs text-graphite">
            Written in <a href="https://mermaid.js.org/intro/syntax-reference.html" target="_blank" rel="noopener noreferrer">Mermaid syntax</a>. The preview updates as you type.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save"}
              </button>
            )}
            <button type="button" className="btn" onClick={exportSvg}>Download SVG</button>
            <button type="button" className="btn" onClick={exportPng}>Download PNG</button>
            <button type="button" className="btn" onClick={() => window.print()}>Print or save as PDF</button>
            {status.ok && !dirty && <span role="status" className="text-sm text-graphite">{status.ok}</span>}
            {status.error && <span role="alert" className="text-sm text-margin">{status.error}</span>}
          </div>
        </div>
        <div>
          <h2 className="print-only mb-4 text-xl font-semibold">{title}</h2>
          <MermaidView source={source} onSvg={onSvg} />
        </div>
      </div>
    </div>
  );
}
