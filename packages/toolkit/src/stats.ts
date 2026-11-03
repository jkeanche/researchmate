// jStat (MIT) provides the distribution functions; all estimates are computed here deterministically.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — jstat ships without types
import jStatModule from "jstat";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const jStat: any = (jStatModule as any).jStat ?? jStatModule;

export type Cell = string | number | null;
const isNum = (v: Cell): v is number => typeof v === "number" && Number.isFinite(v);
/** Two-sided p for t from the lower tail (accurate for very small p). */
const pT = (t: number, df: number) => 2 * jStat.studentt.cdf(-Math.abs(t), df);
/** Upper-tail p for F via the regularized incomplete beta (accurate for very small p). */
const pF = (F: number, d1: number, d2: number) => (F > 0 ? jStat.ibeta(d2 / (d2 + d1 * F), d2 / 2, d1 / 2) : 1);
const round = (x: number, d = 6) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

export function quantile(sorted: number[], p: number): number {
  // Type 7 (the default in R and NumPy).
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  return sorted[lo]! + (h - lo) * ((sorted[Math.min(lo + 1, sorted.length - 1)] ?? sorted[lo]!) - sorted[lo]!);
}

export function describe(values: Cell[]) {
  const x = values.filter(isNum);
  const n = x.length;
  const missing = values.length - n;
  if (!n) return { n, missing, mean: null, sd: null, se: null, min: null, q1: null, median: null, q3: null, max: null };
  const mean = x.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const s = [...x].sort((a, b) => a - b);
  return { n, missing, mean: round(mean), sd: round(sd), se: round(sd / Math.sqrt(n)), min: s[0]!, q1: round(quantile(s, 0.25)), median: round(quantile(s, 0.5)), q3: round(quantile(s, 0.75)), max: s[n - 1]! };
}

export function frequencies(values: Cell[]) {
  const counts = new Map<string, number>();
  let missing = 0;
  for (const v of values) {
    if (v === null || v === "") missing++;
    else counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  }
  const valid = values.length - missing;
  const rows = [...counts.entries()].sort((a, b) => (isNaN(Number(a[0])) || isNaN(Number(b[0])) ? a[0].localeCompare(b[0]) : Number(a[0]) - Number(b[0]))).map(([value, count]) => ({ value, count, percent: round((100 * count) / values.length, 2), validPercent: round((100 * count) / valid, 2) }));
  return { n: values.length, missing, rows };
}

/** Pearson χ² test of independence with Cramér's V. */
export function crosstab(a: Cell[], b: Cell[]) {
  const pairs = a.map((v, i) => [v, b[i]] as const).filter(([x, y]) => x !== null && x !== "" && y !== null && y !== "");
  const rowsL = [...new Set(pairs.map(([x]) => String(x)))].sort();
  const colsL = [...new Set(pairs.map(([, y]) => String(y)))].sort();
  const table = rowsL.map((r) => colsL.map((c) => pairs.filter(([x, y]) => String(x) === r && String(y) === c).length));
  const n = pairs.length;
  const rowT = table.map((r) => r.reduce((s, v) => s + v, 0));
  const colT = colsL.map((_, j) => table.reduce((s, r) => s + r[j]!, 0));
  let chi2 = 0;
  let lowExpected = 0;
  table.forEach((r, i) =>
    r.forEach((o, j) => {
      const e = (rowT[i]! * colT[j]!) / n;
      if (e < 5) lowExpected++;
      chi2 += e > 0 ? (o - e) ** 2 / e : 0;
    }),
  );
  const df = (rowsL.length - 1) * (colsL.length - 1);
  const p = df > 0 ? 1 - jStat.chisquare.cdf(chi2, df) : NaN;
  const k = Math.min(rowsL.length, colsL.length);
  return { rows: rowsL, columns: colsL, table, rowTotals: rowT, columnTotals: colT, n, chi2: round(chi2), df, p: round(p, 8), cramersV: k > 1 ? round(Math.sqrt(chi2 / (n * (k - 1)))) : null, cellsExpectedBelow5: lowExpected, cells: rowsL.length * colsL.length };
}

const ranks = (x: number[]) => {
  const idx = x.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
  const r = new Array<number>(x.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
};

export function correlation(xIn: Cell[], yIn: Cell[], method: "pearson" | "spearman" = "pearson") {
  const pairs = xIn.map((v, i) => [v, yIn[i] ?? null] as const).filter((p): p is readonly [number, number] => isNum(p[0]) && isNum(p[1]));
  let x = pairs.map((p) => p[0]);
  let y = pairs.map((p) => p[1]);
  if (method === "spearman") [x, y] = [ranks(x), ranks(y)];
  const n = x.length;
  if (n < 3) return { method, n, r: null, t: null, df: null, p: null };
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  const r = sxy / Math.sqrt(sxx * syy);
  const df = n - 2;
  const t = (r * Math.sqrt(df)) / Math.sqrt(Math.max(1e-300, 1 - r * r));
  const p = pT(t, df);
  return { method, n, r: round(r), t: round(t), df, p };
}

/** Solves A x = b by Gauss–Jordan elimination with partial pivoting; returns A⁻¹ too. */
function invert(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (Math.abs(M[piv]![c]!) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    const d = M[c]![c]!;
    for (let k = 0; k < 2 * n; k++) M[c]![k]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f) for (let k = 0; k < 2 * n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row) => row.slice(n));
}

/**
 * Ordinary least squares. Categorical predictors are dummy-coded against
 * their first level (alphabetical). Listwise deletion of missing values.
 */
export function regression(y: Cell[], predictors: { name: string; values: Cell[]; categorical: boolean }[]) {
  const levels = predictors.map((p) => (p.categorical ? [...new Set(p.values.filter((v) => v !== null && v !== "").map(String))].sort() : []));
  const names = ["(Intercept)", ...predictors.flatMap((p, k) => (p.categorical ? levels[k]!.slice(1).map((l) => `${p.name} = ${l}`) : [p.name]))];
  const X: number[][] = [];
  const Y: number[] = [];
  for (let i = 0; i < y.length; i++) {
    if (!isNum(y[i]!)) continue;
    const row = [1];
    let ok = true;
    predictors.forEach((p, k) => {
      const v = p.values[i];
      if (p.categorical) {
        if (v === null || v === "" || v === undefined) ok = false;
        else for (const l of levels[k]!.slice(1)) row.push(String(v) === l ? 1 : 0);
      } else if (isNum(v as Cell)) row.push(v as number);
      else ok = false;
    });
    if (ok) {
      X.push(row);
      Y.push(y[i] as number);
    }
  }
  const n = X.length;
  const k = names.length;
  if (n <= k) throw new Error(`Not enough complete cases (${n}) for ${k} coefficients.`);
  const XtX = names.map((_, a) => names.map((_, b) => X.reduce((s, r) => s + r[a]! * r[b]!, 0)));
  const inv = invert(XtX);
  if (!inv) throw new Error("The predictors are perfectly collinear (or a category has no cases); remove one.");
  const Xty = names.map((_, a) => X.reduce((s, r, i) => s + r[a]! * Y[i]!, 0));
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j]!, 0));
  const fitted = X.map((r) => r.reduce((s, v, j) => s + v * beta[j]!, 0));
  const my = Y.reduce((a, b) => a + b, 0) / n;
  const sse = Y.reduce((s, v, i) => s + (v - fitted[i]!) ** 2, 0);
  const sst = Y.reduce((s, v) => s + (v - my) ** 2, 0);
  const dfRes = n - k;
  const sigma2 = sse / dfRes;
  const coefficients = names.map((name, j) => {
    const se = Math.sqrt(sigma2 * inv[j]![j]!);
    const t = beta[j]! / se;
    const p = pT(t, dfRes);
    const tc = jStat.studentt.inv(0.975, dfRes);
    return { name, estimate: round(beta[j]!), se: round(se), t: round(t), p, ci95: [round(beta[j]! - tc * se), round(beta[j]! + tc * se)] };
  });
  const r2 = 1 - sse / sst;
  const dfModel = k - 1;
  const F = dfModel > 0 ? (sst - sse) / dfModel / sigma2 : NaN;
  return { n, coefficients, r2: round(r2), adjR2: round(1 - (1 - r2) * ((n - 1) / dfRes)), F: round(F), dfModel, dfResidual: dfRes, pF: dfModel > 0 ? pF(F, dfModel, dfRes) : null, residualSE: round(Math.sqrt(sigma2)) };
}

/** Welch's two-sample t-test (unequal variances) with Cohen's d (pooled SD). */
export function ttest(y: Cell[], group: Cell[]) {
  const groups = new Map<string, number[]>();
  y.forEach((v, i) => {
    const g = group[i];
    if (isNum(v) && g !== null && g !== "") groups.set(String(g), [...(groups.get(String(g)) ?? []), v]);
  });
  if (groups.size !== 2) throw new Error(`A t-test needs exactly two groups; found ${groups.size}.`);
  const [[ga, a], [gb, b]] = [...groups.entries()].sort((p, q) => p[0].localeCompare(q[0])) as [[string, number[]], [string, number[]]];
  const m = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const v = (x: number[]) => x.reduce((s, z) => s + (z - m(x)) ** 2, 0) / (x.length - 1);
  if (a.length < 2 || b.length < 2) throw new Error("Each group needs at least two values.");
  const se = Math.sqrt(v(a) / a.length + v(b) / b.length);
  const t = (m(a) - m(b)) / se;
  const df = (v(a) / a.length + v(b) / b.length) ** 2 / ((v(a) / a.length) ** 2 / (a.length - 1) + (v(b) / b.length) ** 2 / (b.length - 1));
  const p = pT(t, df);
  const tc = jStat.studentt.inv(0.975, df);
  const pooled = Math.sqrt(((a.length - 1) * v(a) + (b.length - 1) * v(b)) / (a.length + b.length - 2));
  return { groups: [{ name: ga, n: a.length, mean: round(m(a)), sd: round(Math.sqrt(v(a))) }, { name: gb, n: b.length, mean: round(m(b)), sd: round(Math.sqrt(v(b))) }], difference: round(m(a) - m(b)), t: round(t), df: round(df), p, ci95: [round(m(a) - m(b) - tc * se), round(m(a) - m(b) + tc * se)], cohensD: round((m(a) - m(b)) / pooled) };
}

/** One-way ANOVA with η². */
export function anova(y: Cell[], group: Cell[]) {
  const groups = new Map<string, number[]>();
  y.forEach((v, i) => {
    const g = group[i];
    if (isNum(v) && g !== null && g !== "") groups.set(String(g), [...(groups.get(String(g)) ?? []), v]);
  });
  if (groups.size < 2) throw new Error("ANOVA needs at least two groups.");
  const all = [...groups.values()].flat();
  const N = all.length;
  const grand = all.reduce((s, v) => s + v, 0) / N;
  let ssb = 0;
  let ssw = 0;
  const summary = [...groups.entries()].sort((p, q) => p[0].localeCompare(q[0])).map(([name, x]) => {
    const mean = x.reduce((s, v) => s + v, 0) / x.length;
    ssb += x.length * (mean - grand) ** 2;
    ssw += x.reduce((s, v) => s + (v - mean) ** 2, 0);
    return { name, n: x.length, mean: round(mean) };
  });
  const df1 = groups.size - 1;
  const df2 = N - groups.size;
  const F = ssb / df1 / (ssw / df2);
  return { groups: summary, F: round(F), df1, df2, p: pF(F, df1, df2), etaSquared: round(ssb / (ssb + ssw)) };
}

export const METHODS: Record<string, string> = {
  missing: "Count of empty cells per variable.",
  descriptives: "Mean, sample standard deviation (n − 1), standard error, and quartiles (type 7 interpolation, as in R and NumPy). Missing values excluded.",
  frequencies: "Counts with percentages of all cases and of valid (non-missing) cases.",
  crosstab: "Contingency table with Pearson's χ² test of independence (no continuity correction) and Cramér's V. Cells with expected counts below 5 are reported; the χ² approximation is unreliable when many are present.",
  correlation: "Pearson's product-moment correlation (or Spearman's rank correlation, average ranks for ties) with a two-sided t-test, pairwise deletion.",
  regression: "Ordinary least squares regression; categorical predictors dummy-coded against their first category; listwise deletion; two-sided t-tests and 95% confidence intervals for coefficients; overall F-test.",
  ttest: "Welch's two-sample t-test (unequal variances), two-sided, with 95% confidence interval for the difference and Cohen's d (pooled SD).",
  anova: "One-way analysis of variance (equal variances assumed) with η² effect size.",
};
