"use client";

import { useState } from "react";
import { saveSurveyAction } from "@/server/actions/toolkit";

type QType = "single" | "multiple" | "likert" | "open" | "number";
interface Q {
  id: string;
  type: QType;
  text: string;
  required: boolean;
  options?: string[];
  scale?: { points: number; low: string; high: string };
  section?: string;
}

const TYPE_LABELS: Record<QType, string> = { single: "Single choice", multiple: "Multiple choice", likert: "Likert scale", open: "Open text", number: "Number" };
const SCALES: Record<string, { points: number; low: string; high: string; label: string }> = {
  agreement5: { points: 5, low: "Strongly disagree", high: "Strongly agree", label: "Agreement (5 points)" },
  agreement7: { points: 7, low: "Strongly disagree", high: "Strongly agree", label: "Agreement (7 points)" },
  frequency5: { points: 5, low: "Never", high: "Always", label: "Frequency (5 points)" },
  satisfaction5: { points: 5, low: "Very dissatisfied", high: "Very satisfied", label: "Satisfaction (5 points)" },
};

function nextId(qs: Q[]) {
  for (let i = qs.length + 1; ; i++) if (!qs.some((q) => q.id === `q${i}`)) return `q${i}`;
}

export function SurveyEditor({ projectId, survey, canEdit }: { projectId: string; survey: { id: string; title: string; introduction: string; consent: string; questions: Q[]; revision: number }; canEdit: boolean }) {
  const [title, setTitle] = useState(survey.title);
  const [intro, setIntro] = useState(survey.introduction);
  const [consent, setConsent] = useState(survey.consent);
  const [qs, setQs] = useState<Q[]>(survey.questions);
  const [revision, setRevision] = useState(survey.revision);
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [saving, setSaving] = useState(false);

  const update = (i: number, patch: Partial<Q>) => setQs((all) => all.map((q, k) => (k === i ? { ...q, ...patch } : q)));
  const move = (i: number, d: -1 | 1) => setQs((all) => {
    const j = i + d;
    if (j < 0 || j >= all.length) return all;
    const c = [...all];
    [c[i], c[j]] = [c[j]!, c[i]!];
    return c;
  });
  const add = (type: QType) => {
    setMsg({});
    setQs((all) => [...all, { id: nextId(all), type, text: "", required: false, ...(type === "single" || type === "multiple" ? { options: ["", ""] } : {}), ...(type === "likert" ? { scale: { points: 5, low: "Strongly disagree", high: "Strongly agree" } } : {}) }]);
  };

  async function save() {
    setSaving(true);
    const clean = qs.map((q) => ({ ...q, options: q.options?.map((o) => o.trim()).filter(Boolean), section: q.section?.trim() || undefined }));
    const r = await saveSurveyAction({ projectId, surveyId: survey.id, title, introduction: intro, consent, questions: clean, revision });
    setSaving(false);
    if (r.error) return setMsg({ error: r.error });
    setRevision(Number(r.data?.revision ?? revision + 1));
    setMsg({ ok: "Saved." });
  }

  const ro = !canEdit;
  return (
    <div className="grid max-w-3xl gap-4">
      <div className="field">
        <label htmlFor="sv-title">Title</label>
        <input id="sv-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} readOnly={ro} maxLength={200} />
      </div>
      <div className="field">
        <label htmlFor="sv-intro">Introduction for participants</label>
        <textarea id="sv-intro" className="input min-h-24" value={intro} onChange={(e) => setIntro(e.target.value)} readOnly={ro} maxLength={5000} placeholder="Purpose of the study, who is running it, how long it takes, how answers are kept confidential." />
      </div>
      <div className="field">
        <label htmlFor="sv-consent">Consent statement</label>
        <textarea id="sv-consent" className="input min-h-20" value={consent} onChange={(e) => setConsent(e.target.value)} readOnly={ro} maxLength={5000} />
        <p className="text-xs text-graphite">Check this against your ethics approval; your review board may require specific wording.</p>
      </div>

      <ol className="grid gap-3">
        {qs.map((q, i) => (
          <li key={i} className="rounded-md border border-rule bg-sheet p-4" aria-label={`Question ${i + 1}`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">
                {i + 1}. {TYPE_LABELS[q.type]}
              </p>
              {canEdit && (
                <div className="flex gap-1">
                  <button type="button" className="btn btn-quiet px-2 py-0.5 text-xs" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move question ${i + 1} up`}>↑</button>
                  <button type="button" className="btn btn-quiet px-2 py-0.5 text-xs" onClick={() => move(i, 1)} disabled={i === qs.length - 1} aria-label={`Move question ${i + 1} down`}>↓</button>
                  <button type="button" className="btn btn-quiet px-2 py-0.5 text-xs" onClick={() => setQs((all) => all.filter((_, k) => k !== i))} aria-label={`Remove question ${i + 1}`}>Remove</button>
                </div>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
              <div className="field">
                <label htmlFor={`q-id-${i}`}>Variable name</label>
                <input id={`q-id-${i}`} className="input font-mono text-xs" value={q.id} onChange={(e) => update(i, { id: e.target.value })} readOnly={ro} maxLength={41} />
              </div>
              <div className="field">
                <label htmlFor={`q-text-${i}`}>Question</label>
                <input id={`q-text-${i}`} className="input" value={q.text} onChange={(e) => update(i, { text: e.target.value })} readOnly={ro} maxLength={1000} />
              </div>
            </div>
            {(q.type === "single" || q.type === "multiple") && (
              <div className="field mt-2">
                <label htmlFor={`q-opt-${i}`}>Options (one per line)</label>
                <textarea id={`q-opt-${i}`} className="input min-h-20" value={(q.options ?? []).join("\n")} onChange={(e) => update(i, { options: e.target.value.split("\n") })} readOnly={ro} />
              </div>
            )}
            {q.type === "likert" && q.scale && (
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <div className="field">
                  <label htmlFor={`q-scale-${i}`}>Scale</label>
                  <select id={`q-scale-${i}`} className="input" disabled={ro} value={Object.entries(SCALES).find(([, s]) => s.points === q.scale!.points && s.low === q.scale!.low && s.high === q.scale!.high)?.[0] ?? ""} onChange={(e) => { const s = SCALES[e.target.value]; if (s) update(i, { scale: { points: s.points, low: s.low, high: s.high } }); }}>
                    <option value="">Custom</option>
                    {Object.entries(SCALES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`q-low-${i}`}>1 =</label>
                  <input id={`q-low-${i}`} className="input" value={q.scale.low} onChange={(e) => update(i, { scale: { ...q.scale!, low: e.target.value } })} readOnly={ro} maxLength={80} />
                </div>
                <div className="field">
                  <label htmlFor={`q-high-${i}`}>{q.scale.points} =</label>
                  <input id={`q-high-${i}`} className="input" value={q.scale.high} onChange={(e) => update(i, { scale: { ...q.scale!, high: e.target.value } })} readOnly={ro} maxLength={80} />
                </div>
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={q.required} onChange={(e) => update(i, { required: e.target.checked })} disabled={ro} /> Required
              </label>
              <label className="flex items-center gap-2" htmlFor={`q-sec-${i}`}>
                Section
                <input id={`q-sec-${i}`} className="input w-48 py-1" value={q.section ?? ""} onChange={(e) => update(i, { section: e.target.value })} readOnly={ro} maxLength={200} placeholder="optional" />
              </label>
            </div>
          </li>
        ))}
      </ol>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-graphite">Add:</span>
          {(Object.keys(TYPE_LABELS) as QType[]).map((t) => (
            <button key={t} type="button" className="btn btn-quiet text-sm" onClick={() => add(t)}>{TYPE_LABELS[t]}</button>
          ))}
        </div>
      )}
      {canEdit && (
        <div className="flex items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save questionnaire"}</button>
          {msg.ok && <span role="status" className="text-sm text-graphite">{msg.ok}</span>}
          {msg.error && <span role="alert" className="text-sm text-margin">{msg.error}</span>}
        </div>
      )}
    </div>
  );
}
