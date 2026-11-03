/* Server-renderable display of a saved analysis result. */

type R = Record<string, unknown>;
const num = (v: unknown, d = 3) => (typeof v === "number" ? (Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(2) : v.toFixed(d).replace(/\.?0+$/, "") || "0") : v == null ? "—" : String(v));
const pv = (v: unknown) => (typeof v === "number" ? (v < 0.001 ? "< .001" : v.toFixed(3).replace(/^0/, "")) : "—");

function T({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr>{head.map((h, i) => <th key={i} scope="col" className={`border-b border-rule px-2 py-1 font-semibold ${i ? "text-right" : "text-left"}`}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={`border-b border-rule/60 px-2 py-1 ${j ? "text-right tabular-nums" : ""}`}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Horizontal bar chart of counts (accessible: the table above carries the same numbers). */
function Bars({ rows }: { rows: { value: string; count: number }[] }) {
  const shown = rows.slice(0, 20);
  const max = Math.max(1, ...shown.map((r) => r.count));
  const h = 22;
  return (
    <svg role="img" aria-label="Bar chart of counts" viewBox={`0 0 600 ${shown.length * h + 4}`} className="mt-3 w-full max-w-xl">
      {shown.map((r, i) => (
        <g key={r.value} transform={`translate(0 ${i * h + 2})`}>
          <text x="150" y={h / 2 + 4} textAnchor="end" fontSize="12" fill="currentColor">{r.value.length > 22 ? `${r.value.slice(0, 21)}…` : r.value}</text>
          <rect x="158" y="3" width={(r.count / max) * 380} height={h - 6} rx="2" fill="#2f5d8a" />
          <text x={162 + (r.count / max) * 380} y={h / 2 + 4} fontSize="12" fill="currentColor">{r.count}</text>
        </g>
      ))}
    </svg>
  );
}

export function AnalysisResult({ kind, result: r }: { kind: string; result: R }) {
  switch (kind) {
    case "missing":
      return <T head={["Variable", "Missing", "% of rows"]} rows={(r.variables as R[]).map((v) => [String(v.name), Number(v.missing), `${((Number(v.missing) / Math.max(1, Number(r.rows))) * 100).toFixed(1)}%`])} />;
    case "descriptives":
      return <T head={["Variable", "n", "Missing", "Mean", "SD", "Min", "Q1", "Median", "Q3", "Max"]} rows={(r.variables as R[]).map((v) => [String(v.name), num(v.n, 0), num(v.missing, 0), num(v.mean), num(v.sd), num(v.min), num(v.q1), num(v.median), num(v.q3), num(v.max)])} />;
    case "frequencies":
      return (
        <>
          <T head={["Value", "Count", "%", "Valid %"]} rows={(r.rows as R[]).map((v) => [String(v.value), Number(v.count), `${num(v.percent, 1)}%`, `${num(v.validPercent, 1)}%`])} />
          <p className="mt-1 text-xs text-graphite">n = {String(r.n)}; missing = {String(r.missing)}</p>
          <Bars rows={r.rows as { value: string; count: number }[]} />
        </>
      );
    case "crosstab": {
      const cols = r.columns as string[];
      const table = r.table as number[][];
      return (
        <>
          <T head={[`${String(r.row)} \\ ${String(r.column)}`, ...cols, "Total"]} rows={[...(r.rows as string[]).map((rw, i) => [rw, ...table[i]!, (r.rowTotals as number[])[i]!]), ["Total", ...(r.columnTotals as number[]), Number(r.n)]]} />
          <p className="mt-2 text-sm">χ²({String(r.df)}) = {num(r.chi2)}, p = {pv(r.p)}, Cramér’s V = {num(r.cramersV)}, n = {String(r.n)}</p>
          {Number(r.cellsExpectedBelow5) > 0 && <p className="text-xs text-margin">{String(r.cellsExpectedBelow5)} of {String(r.cells)} cells have an expected count below 5; the χ² approximation may be unreliable.</p>}
        </>
      );
    }
    case "correlation":
      return <p className="text-sm">{r.method === "spearman" ? "Spearman ρ" : "Pearson r"}({String(r.df ?? "—")}) = {num(r.r)}, t = {num(r.t)}, p = {pv(r.p)}, n = {String(r.n)}</p>;
    case "ttest": {
      const g = r.groups as R[];
      return (
        <>
          <T head={["Group", "n", "Mean", "SD"]} rows={g.map((x) => [String(x.name), Number(x.n), num(x.mean), num(x.sd)])} />
          <p className="mt-2 text-sm">Difference = {num(r.difference)} (95% CI {num((r.ci95 as number[])[0])} to {num((r.ci95 as number[])[1])}); Welch t({num(r.df, 2)}) = {num(r.t)}, p = {pv(r.p)}; Cohen’s d = {num(r.cohensD)}</p>
        </>
      );
    }
    case "anova":
      return (
        <>
          <T head={["Group", "n", "Mean"]} rows={(r.groups as R[]).map((x) => [String(x.name), Number(x.n), num(x.mean)])} />
          <p className="mt-2 text-sm">F({String(r.df1)}, {String(r.df2)}) = {num(r.F)}, p = {pv(r.p)}, η² = {num(r.etaSquared)}</p>
        </>
      );
    case "regression":
      return (
        <>
          <T head={["Term", "Estimate", "SE", "t", "p", "95% CI"]} rows={(r.coefficients as R[]).map((c) => [String(c.name), num(c.estimate), num(c.se), num(c.t), pv(c.p), `${num((c.ci95 as number[])[0])} to ${num((c.ci95 as number[])[1])}`])} />
          <p className="mt-2 text-sm">n = {String(r.n)}; R² = {num(r.r2)}; adjusted R² = {num(r.adjR2)}; F({String(r.dfModel)}, {String(r.dfResidual)}) = {num(r.F)}, p = {pv(r.pF)}; residual SE = {num(r.residualSE)}</p>
        </>
      );
    default:
      return <pre className="text-xs">{JSON.stringify(r, null, 2)}</pre>;
  }
}
