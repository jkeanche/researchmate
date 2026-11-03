import { CITATION_STYLES } from "@researchmate/citations";
import { ActionForm, Field } from "@/components/action-form";
import { Section } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { documentAction } from "@/server/actions/documents";
import { DOC_STATUS, loadDocument, SECTION_KIND } from "@/server/documents";
import { documentService } from "@/server/services";

export const metadata = { title: "Specification" };

function Select({ id, label, name, value, options }: { id: string; label: string; name: string; value: string; options: [string, string][] }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name} className="input" defaultValue={value}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

export default async function SettingsPage({ params }: { params: Promise<{ projectId: string; documentId: string }> }) {
  const { projectId, documentId } = await params;
  const d = await loadDocument(projectId, documentId);
  const history = await (await documentService()).specHistory(d.session.user.id, documentId);
  const s = d.spec;
  const m = d.document.meta;
  const hidden = (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="documentId" value={documentId} />
    </>
  );
  const ro = !d.canEdit;
  return (
    <fieldset disabled={ro} className="grid gap-2">
      <Section title="Details and title page">
        <ActionForm action={documentAction} submitLabel="Save details" className="grid max-w-3xl gap-4">
          {hidden}
          <input type="hidden" name="intent" value="details" />
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Field id="dt-title" label="Title" name="title" defaultValue={d.document.title} required maxLength={300} />
            <Select id="dt-status" label="Status" name="status" value={d.document.status} options={Object.entries(DOC_STATUS)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="dt-subtitle" label="Subtitle" name="subtitle" defaultValue={m.subtitle} maxLength={300} />
            <Field id="dt-author" label="Author" name="author" defaultValue={m.author} maxLength={300} />
            <Field id="dt-degree" label="Degree" name="degree" defaultValue={m.degree} maxLength={300} />
            <Field id="dt-label" label="Submitted as a" name="documentLabel" defaultValue={m.documentLabel} maxLength={60} placeholder="dissertation / thesis / project" />
            <Field id="dt-dept" label="Department" name="department" defaultValue={m.department} maxLength={300} />
            <Field id="dt-inst" label="Institution" name="institution" defaultValue={m.institution} maxLength={300} />
            <Field id="dt-sup" label="Supervisor" name="supervisor" defaultValue={m.supervisor} maxLength={300} />
            <Field id="dt-date" label="Date on title page" name="date" defaultValue={m.date} maxLength={60} placeholder="e.g. November 2026" />
          </div>
        </ActionForm>
      </Section>

      <Section title="Formatting and limits" description={`Specification version ${d.document.specVersion}. Changes create a new version; earlier versions are kept, and each export records which one it used.`}>
        <ActionForm action={documentAction} submitLabel="Save specification" className="grid max-w-3xl gap-4">
          {hidden}
          <input type="hidden" name="intent" value="spec" />
          <div className="grid gap-4 sm:grid-cols-3">
            <Select id="sp-style" label="Citation style" name="citationStyle" value={s.citationStyle} options={Object.entries(CITATION_STYLES).map(([k, v]) => [k, v.name])} />
            <Select id="sp-size" label="Paper" name="pageSize" value={s.page.size} options={[["A4", "A4"], ["Letter", "US Letter"]]} />
            <Select id="sp-ls" label="Line spacing" name="lineSpacing" value={String(s.lineSpacing)} options={[["1", "Single"], ["1.15", "1.15"], ["1.5", "1.5"], ["2", "Double"]]} />
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            {(["Top", "Bottom", "Left", "Right"] as const).map((k) => (
              <Field key={k} id={`sp-m${k}`} label={`${k} margin (mm)`} name={`margin${k}`} type="number" min={5} max={60} step={0.5} defaultValue={s.page.marginsMm[k.toLowerCase() as "top"]} required />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="sp-font" label="Font" name="fontFamily" defaultValue={s.font.family} required maxLength={60} hint="Times New Roman and Calibri print with metric-compatible fonts" />
            <Field id="sp-fsize" label="Size (pt)" name="fontSize" type="number" min={8} max={16} step={0.5} defaultValue={s.font.sizePt} required />
            <Field id="sp-hfont" label="Heading font" name="headingFont" defaultValue={s.headingFont} maxLength={60} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="sp-before" label="Space before paragraph (pt)" name="spaceBefore" type="number" min={0} max={36} defaultValue={s.paragraph.spaceBeforePt} required />
            <Field id="sp-after" label="Space after paragraph (pt)" name="spaceAfter" type="number" min={0} max={36} defaultValue={s.paragraph.spaceAfterPt} required />
            <Field id="sp-indent" label="First-line indent (mm)" name="firstLineIndent" type="number" min={0} max={25} defaultValue={s.paragraph.firstLineIndentMm} required />
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <Select id="sp-pn" label="Page numbers" name="pageNumberPosition" value={s.pageNumbers.position} options={[["bottom-center", "Bottom centre"], ["bottom-right", "Bottom right"], ["top-right", "Top right"], ["none", "None"]]} />
            <Select id="sp-pre" label="Preliminary pages" name="prelims" value={s.pageNumbers.prelims} options={[["roman", "Roman (i, ii…)"], ["none", "Same as main text"]]} />
            <Select id="sp-tc" label="Table captions" name="tableCaption" value={s.captions.table} options={[["above", "Above"], ["below", "Below"]]} />
            <Select id="sp-fc" label="Figure captions" name="figureCaption" value={s.captions.figure} options={[["above", "Above"], ["below", "Below"]]} />
          </div>
          <div className="flex flex-wrap gap-6 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="headingNumbering" defaultChecked={s.headingNumbering} /> Number headings (1, 1.1, 1.1.1)</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="titlePage" defaultChecked={s.titlePage} /> Separate title page</label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="sp-header" label="Running header" name="header" defaultValue={s.header} maxLength={200} />
            <Field id="sp-footer" label="Footer text" name="footer" defaultValue={s.footer} maxLength={200} />
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field id="sp-minw" label="Minimum words" name="minWords" type="number" min={1} defaultValue={s.limits.minWords ?? ""} />
            <Field id="sp-maxw" label="Maximum words" name="maxWords" type="number" min={1} defaultValue={s.limits.maxWords ?? ""} />
            <Field id="sp-maxp" label="Maximum pages" name="maxPages" type="number" min={1} defaultValue={s.limits.maxPages ?? ""} />
            <Field id="sp-abs" label="Abstract words" name="abstractMaxWords" type="number" min={1} defaultValue={s.limits.abstractMaxWords ?? ""} />
          </div>
          <Field id="sp-note" label="Reason for the change (optional)" name="note" maxLength={300} placeholder="e.g. Faculty guidelines 2026" />
        </ActionForm>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-graphite">History ({history.length})</summary>
          <ul className="mt-2 grid gap-1">
            {history.map((h) => <li key={h.version}>Version {h.version} · {h.note || "No note"} · {h.by ?? "System"} · {formatDateTime(h.createdAt)}</li>)}
          </ul>
        </details>
      </Section>

      <Section title="Sections" description="Required sections come from the template. Add, rename or reorder sections; optional sections left empty are not printed.">
        <ul className="grid gap-2">
          {d.sections.map((sec, i) => {
            const prev = d.sections[i - 1];
            const next = d.sections[i + 1];
            const fixed = ["title", "toc", "references"].includes(sec.kind);
            return (
              <li key={sec.id} className="flex flex-wrap items-end gap-2 rounded-md border border-rule bg-sheet px-3 py-2 text-sm">
                <span className="w-32 shrink-0 text-xs text-graphite">{SECTION_KIND[sec.kind]}{sec.required ? " · required" : ""}</span>
                {fixed ? (
                  <span className="flex-1">{sec.title}</span>
                ) : (
                  <ActionForm action={documentAction} submitLabel="Save" variant="quiet" className="flex flex-1 flex-wrap items-end gap-2">
                    {hidden}
                    <input type="hidden" name="intent" value="rename_section" />
                    <input type="hidden" name="sectionId" value={sec.id} />
                    <div className="field min-w-48 flex-1">
                      <label htmlFor={`sn-${sec.id}`} className="sr-only">Title of {sec.title}</label>
                      <input id={`sn-${sec.id}`} name="title" className="input" defaultValue={sec.title} required maxLength={200} />
                    </div>
                    <div className="field w-28">
                      <label htmlFor={`sw-${sec.id}`} className="sr-only">Word limit for {sec.title}</label>
                      <input id={`sw-${sec.id}`} name="wordLimit" type="number" min={1} className="input" defaultValue={sec.wordLimit ?? ""} placeholder="Word limit" />
                    </div>
                  </ActionForm>
                )}
                {!fixed && (
                  <span className="flex gap-1">
                    {(["up", "down"] as const).map((dir) => {
                      const other = dir === "up" ? prev : next;
                      return other && other.kind === sec.kind ? (
                        <ActionForm key={dir} action={documentAction} submitLabel={dir === "up" ? "↑" : "↓"} variant="quiet" className="flex">
                          {hidden}
                          <input type="hidden" name="intent" value="move_section" />
                          <input type="hidden" name="sectionId" value={sec.id} />
                          <input type="hidden" name="direction" value={dir} />
                        </ActionForm>
                      ) : null;
                    })}
                    {!sec.required && !sec.content.trim() && (
                      <ActionForm action={documentAction} submitLabel="Remove" variant="danger" className="flex">
                        {hidden}
                        <input type="hidden" name="intent" value="remove_section" />
                        <input type="hidden" name="sectionId" value={sec.id} />
                      </ActionForm>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <ActionForm action={documentAction} submitLabel="Add section" variant="quiet" resetOnSuccess className="mt-4 flex flex-wrap items-end gap-2">
          {hidden}
          <input type="hidden" name="intent" value="add_section" />
          <Field id="as-title" label="New section" name="title" required maxLength={200} />
          <Select id="as-kind" label="Kind" name="kind" value="body" options={[["body", "Main text"], ["front", "Preliminary"], ["appendix", "Appendix"]]} />
        </ActionForm>
      </Section>

      {d.canEdit && (
        <Section title="Delete document">
          <ActionForm action={documentAction} submitLabel="Delete this document" variant="danger" className="grid gap-2">
            {hidden}
            <input type="hidden" name="intent" value="delete" />
            <p className="text-sm text-graphite">Deletes the document, its versions, comments and exports. Library sources and evidence are kept.</p>
          </ActionForm>
        </Section>
      )}
    </fieldset>
  );
}
