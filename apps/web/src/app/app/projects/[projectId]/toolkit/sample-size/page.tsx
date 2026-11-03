import { sampleSizeProportion, sampleSizeTwoMeans } from "@researchmate/toolkit";
import { Section } from "@/components/ui";
import { loadToolkit } from "@/server/toolkit";

export const metadata = { title: "Sample size" };

type SP = Record<string, string | undefined>;
const n = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

function run<T>(fn: () => T): { ok?: T; error?: string } {
  try {
    return { ok: fn() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function Shown({ formula, assumptions, children }: { formula: string; assumptions: string[]; children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-md border border-rule bg-sheet p-4 text-sm" role="status">
      {children}
      <p className="mt-3 font-mono text-xs">{formula}</p>
      <ul className="mt-2 list-disc pl-5 text-xs text-graphite">
        {assumptions.map((a) => <li key={a}>{a}</li>)}
      </ul>
    </div>
  );
}

export default async function SampleSizePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<SP> }) {
  const { projectId } = await params;
  await loadToolkit(projectId);
  const sp = await searchParams;
  const prop = sp.calc === "proportion" ? run(() => sampleSizeProportion({ confidence: n(sp.confidence, 95) / 100, margin: n(sp.margin, 5) / 100, p: n(sp.p, 50) / 100, population: sp.population ? Number(sp.population) : null })) : null;
  const means = sp.calc === "means" ? run(() => sampleSizeTwoMeans({ alpha: n(sp.alpha, 5) / 100, power: n(sp.power, 80) / 100, sd: n(sp.sd, 1), difference: n(sp.difference, 0.5) })) : null;
  const f = (v: number, d = 3) => v.toFixed(d);
  return (
    <>
      <p className="mb-6 max-w-3xl text-sm text-graphite">These calculators show their formula and assumptions. Check the result with your supervisor or a statistician; the right method depends on your design.</p>
      <Section title="Estimating a proportion" description="For surveys that estimate a percentage, such as the share of households using mobile money.">
        <form className="grid max-w-3xl gap-3 sm:grid-cols-4 sm:items-end">
          <input type="hidden" name="calc" value="proportion" />
          <div className="field"><label htmlFor="ss-conf">Confidence level (%)</label><input id="ss-conf" name="confidence" type="number" step="any" min="50" max="99.99" className="input" defaultValue={sp.calc === "proportion" ? sp.confidence : "95"} /></div>
          <div className="field"><label htmlFor="ss-margin">Margin of error (± %)</label><input id="ss-margin" name="margin" type="number" step="any" min="0.1" max="49" className="input" defaultValue={sp.calc === "proportion" ? sp.margin : "5"} /></div>
          <div className="field"><label htmlFor="ss-p">Expected proportion (%)</label><input id="ss-p" name="p" type="number" step="any" min="1" max="99" className="input" defaultValue={sp.calc === "proportion" ? sp.p : "50"} /></div>
          <div className="field"><label htmlFor="ss-pop">Population size (optional)</label><input id="ss-pop" name="population" type="number" min="1" step="1" className="input" defaultValue={sp.calc === "proportion" ? sp.population : ""} /></div>
          <button className="btn btn-primary sm:col-span-4 sm:justify-self-start" type="submit">Calculate</button>
        </form>
        {prop?.error && <p role="alert" className="mt-3 text-sm text-margin">{prop.error}</p>}
        {prop?.ok && (
          <Shown formula={prop.ok.formula} assumptions={prop.ok.assumptions}>
            <p className="text-lg font-semibold">Required sample: {prop.ok.n.toLocaleString("en")}</p>
            <p className="text-graphite">z = {f(prop.ok.z)}; n₀ = {f(prop.ok.n0, 2)}</p>
          </Shown>
        )}
      </Section>
      <Section title="Comparing two group means" description="For studies comparing an outcome between two groups, such as savings among users and non-users.">
        <form className="grid max-w-3xl gap-3 sm:grid-cols-4 sm:items-end">
          <input type="hidden" name="calc" value="means" />
          <div className="field"><label htmlFor="ss-alpha">Significance level α (%)</label><input id="ss-alpha" name="alpha" type="number" step="any" min="0.1" max="20" className="input" defaultValue={sp.calc === "means" ? sp.alpha : "5"} /></div>
          <div className="field"><label htmlFor="ss-power">Power (%)</label><input id="ss-power" name="power" type="number" step="any" min="51" max="99.9" className="input" defaultValue={sp.calc === "means" ? sp.power : "80"} /></div>
          <div className="field"><label htmlFor="ss-sd">Standard deviation σ</label><input id="ss-sd" name="sd" type="number" step="any" min="0" className="input" defaultValue={sp.calc === "means" ? sp.sd : "1"} /></div>
          <div className="field"><label htmlFor="ss-diff">Smallest difference δ to detect</label><input id="ss-diff" name="difference" type="number" step="any" min="0" className="input" defaultValue={sp.calc === "means" ? sp.difference : "0.5"} /></div>
          <button className="btn btn-primary sm:col-span-4 sm:justify-self-start" type="submit">Calculate</button>
        </form>
        {means?.error && <p role="alert" className="mt-3 text-sm text-margin">{means.error}</p>}
        {means?.ok && (
          <Shown formula={means.ok.formula} assumptions={means.ok.assumptions}>
            <p className="text-lg font-semibold">{means.ok.nPerGroup.toLocaleString("en")} per group ({means.ok.total.toLocaleString("en")} in total)</p>
            <p className="text-graphite">Standardised effect size d = {f(means.ok.effectSize)}; z₁₋α/₂ = {f(means.ok.zAlpha)}; z₁₋β = {f(means.ok.zBeta)}</p>
          </Shown>
        )}
      </Section>
    </>
  );
}
