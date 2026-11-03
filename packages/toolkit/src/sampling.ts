import { jStat } from "./stats";

const z = (p: number) => jStat.normal.inv(p, 0, 1);
const check = (v: number, lo: number, hi: number, what: string) => {
  if (!Number.isFinite(v) || v <= lo || v >= hi) throw new Error(`${what} must be between ${lo} and ${hi}.`);
};

/**
 * Sample size to estimate a proportion (Cochran 1977), with the finite
 * population correction when a population size is given.
 */
export function sampleSizeProportion(input: { confidence: number; margin: number; p: number; population?: number | null }) {
  check(input.confidence, 0.5, 1, "Confidence level");
  check(input.margin, 0, 0.5, "Margin of error");
  check(input.p, 0, 1, "Expected proportion");
  const zc = z(1 - (1 - input.confidence) / 2);
  const n0 = (zc ** 2 * input.p * (1 - input.p)) / input.margin ** 2;
  const N = input.population && input.population > 0 ? Math.floor(input.population) : null;
  const n = N ? n0 / (1 + (n0 - 1) / N) : n0;
  return {
    z: zc,
    n0,
    n: Math.ceil(n - 1e-9),
    formula: N ? "n₀ = z² · p(1 − p) / e²;  n = n₀ / (1 + (n₀ − 1) / N)" : "n = z² · p(1 − p) / e²",
    assumptions: ["Simple random sampling (multiply by the design effect for cluster or multistage designs).", "Normal approximation to the binomial.", "p = 0.5 gives the most conservative (largest) sample when the proportion is unknown.", "Inflate the result for expected non-response: n ÷ (1 − non-response rate)."],
  };
}

/** Sample size per group to detect a difference between two means (two-sided z approximation). */
export function sampleSizeTwoMeans(input: { alpha: number; power: number; sd: number; difference: number }) {
  check(input.alpha, 0, 0.5, "Significance level");
  check(input.power, 0.5, 1, "Power");
  if (!(input.sd > 0) || !(input.difference > 0)) throw new Error("Standard deviation and difference must be positive.");
  const za = z(1 - input.alpha / 2);
  const zb = z(input.power);
  const nPer = (2 * (za + zb) ** 2 * input.sd ** 2) / input.difference ** 2;
  return {
    zAlpha: za,
    zBeta: zb,
    effectSize: input.difference / input.sd,
    nPerGroup: Math.ceil(nPer - 1e-9),
    total: 2 * Math.ceil(nPer - 1e-9),
    formula: "n per group = 2 (z₁₋α/₂ + z₁₋β)² σ² / δ²",
    assumptions: ["Two independent groups of equal size with a common standard deviation σ.", "Normal approximation; a t-test needs one or two more participants per group for small samples.", "σ should come from a pilot study or published research, not a guess.", "Inflate for expected attrition."],
  };
}
