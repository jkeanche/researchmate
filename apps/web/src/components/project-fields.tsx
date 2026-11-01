import { CITATION_STYLE_LABELS, RESEARCH_TYPE_LABELS } from "@researchmate/research";
import { Field } from "./action-form";

type Defaults = Partial<{
  title: string;
  description: string;
  researchType: string;
  academicLevel: string | null;
  discipline: string | null;
  institution: string | null;
  department: string | null;
  methodology: string | null;
  citationStyle: string;
  targetWordCount: number | null;
  targetPageCount: number | null;
  startDate: string | null;
  expectedCompletionDate: string | null;
}>;

const ACADEMIC_LEVELS = ["Undergraduate", "Master's", "PhD", "Postdoctoral", "Professional", "Other"];

/** Shared project form fields (create and edit). */
export function ProjectFields({ d = {}, disabled = false }: { d?: Defaults; disabled?: boolean }) {
  return (
    <fieldset disabled={disabled} className="grid gap-5">
      <Field label="Title" name="title" required minLength={3} maxLength={300} defaultValue={d.title} hint="A working title is fine; you can refine it later." />
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="field">
          <label htmlFor="f-researchType">Research type</label>
          <select id="f-researchType" name="researchType" className="input" defaultValue={d.researchType ?? "masters_thesis"} required>
            {Object.entries(RESEARCH_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-academicLevel">Academic level</label>
          <select id="f-academicLevel" name="academicLevel" className="input" defaultValue={d.academicLevel ?? ""}>
            <option value="">Not specified</option>
            {ACADEMIC_LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="f-description">Description</label>
        <textarea id="f-description" name="description" className="input" maxLength={5000} defaultValue={d.description ?? ""} placeholder="What is this research about, and why does it matter?" />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Discipline" name="discipline" maxLength={150} defaultValue={d.discipline} placeholder="e.g. Public health" />
        <Field label="Institution" name="institution" maxLength={200} defaultValue={d.institution} />
        <Field label="Department" name="department" maxLength={200} defaultValue={d.department} />
        <div className="field">
          <label htmlFor="f-citationStyle">Citation style</label>
          <select id="f-citationStyle" name="citationStyle" className="input" defaultValue={d.citationStyle ?? "apa7"}>
            {Object.entries(CITATION_STYLE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="f-methodology">Methodology</label>
        <textarea id="f-methodology" name="methodology" className="input min-h-20" maxLength={2000} defaultValue={d.methodology ?? ""} placeholder="e.g. Mixed methods: household survey followed by key-informant interviews" />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Target word count" name="targetWordCount" type="number" min={0} max={2000000} step={1} defaultValue={d.targetWordCount} />
        <Field label="Target page count" name="targetPageCount" type="number" min={0} max={10000} step={1} defaultValue={d.targetPageCount} />
        <Field label="Start date" name="startDate" type="date" defaultValue={d.startDate} />
        <Field label="Expected completion" name="expectedCompletionDate" type="date" defaultValue={d.expectedCompletionDate} />
      </div>
    </fieldset>
  );
}
