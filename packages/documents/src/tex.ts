/**
 * Equations are typed in a TeX-like notation and printed as text with the
 * common symbols converted (Greek letters, operators, simple sub/superscripts).
 * This is a readable rendering, not a full TeX engine.
 */
const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  sum: "∑", prod: "∏", int: "∫", infty: "∞", partial: "∂", nabla: "∇", sqrt: "√", pm: "±", mp: "∓", times: "×", cdot: "·", div: "÷",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "∼", propto: "∝", in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩",
  rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", Leftrightarrow: "⇔", forall: "∀", exists: "∃", ldots: "…", cdots: "⋯", hat: "", bar: "", mathrm: "", text: "", left: "", right: "",
};
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", T: "ᵀ" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", i: "ᵢ", j: "ⱼ", t: "ₜ", n: "ₙ", k: "ₖ", m: "ₘ", x: "ₓ" };

const script = (s: string, map: Record<string, string>, mark: string) => ([...s].every((c) => map[c]) ? [...s].map((c) => map[c]).join("") : `${mark}(${s})`);

export function texToText(tex: string): string {
  let s = tex.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)");
  s = s.replace(/\\([A-Za-z]+)/g, (m, name: string) => (name in SYMBOLS ? SYMBOLS[name]! : m));
  s = s.replace(/\^\{([^{}]*)\}|\^(\S)/g, (_, a: string | undefined, b: string | undefined) => script(a ?? b!, SUP, "^"));
  s = s.replace(/_\{([^{}]*)\}|_(\S)/g, (_, a: string | undefined, b: string | undefined) => script(a ?? b!, SUB, "_"));
  return s.replace(/[{}]/g, "").replace(/\\,|\;|\\ /g, " ").replace(/\s+/g, " ").trim();
}
