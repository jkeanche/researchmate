import type { CslItem, CslName } from "./csl";

/** Normalises a DOI from "https://doi.org/10.1/x", "doi:10.1/x" etc. Returns null if not a DOI. */
export function normalizeDoi(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = /(10\.\d{4,9}\/[^\s"<>]+)/i.exec(input.trim());
  return m ? m[1]!.replace(/[.,;]+$/, "").toLowerCase() : null;
}

export function parseName(raw: string): CslName {
  const s = raw.trim().replace(/\s+/g, " ");
  if (/^\{.*\}$/.test(s)) return { literal: s.slice(1, -1) };
  if (s.includes(",")) {
    const [family, given] = s.split(",", 2).map((x) => x!.trim());
    return given ? { family, given } : { family };
  }
  const parts = s.split(" ");
  if (parts.length === 1) return { family: s };
  // Keep lower-case particles with the family name (van, de, von…).
  let i = parts.length - 1;
  while (i > 1 && /^[a-z]/.test(parts[i - 1]!)) i--;
  return { given: parts.slice(0, i).join(" "), family: parts.slice(i).join(" ") };
}

const nameToString = (n: CslName) => n.literal ?? [n.family, n.given].filter(Boolean).join(", ");

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

const BIB_TO_CSL: Record<string, string> = {
  article: "article-journal",
  book: "book",
  inbook: "chapter",
  incollection: "chapter",
  inproceedings: "paper-conference",
  conference: "paper-conference",
  phdthesis: "thesis",
  mastersthesis: "thesis",
  techreport: "report",
  manual: "book",
  misc: "document",
  online: "webpage",
  unpublished: "manuscript",
};
const CSL_TO_BIB: Record<string, string> = { "article-journal": "article", book: "book", chapter: "incollection", "paper-conference": "inproceedings", thesis: "phdthesis", report: "techreport", webpage: "online", manuscript: "unpublished" };

function unlatex(s: string): string {
  return s
    .replace(/\\&/g, "&")
    .replace(/\\%/g, "%")
    .replace(/\\_/g, "_")
    .replace(/\\'\{?([aeiouAEIOU])\}?/g, (_m, c: string) => ({ a: "á", e: "é", i: "í", o: "ó", u: "ú", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú" })[c] ?? c)
    .replace(/\\"\{?([aouAOU])\}?/g, (_m, c: string) => ({ a: "ä", o: "ö", u: "ü", A: "Ä", O: "Ö", U: "Ü" })[c] ?? c)
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parses BibTeX into CSL items. Unparseable entries are reported, not dropped silently. */
export function parseBibtex(src: string): { items: CslItem[]; errors: string[] } {
  const items: CslItem[] = [];
  const errors: string[] = [];
  const strings: Record<string, string> = {};
  let i = 0;
  while ((i = src.indexOf("@", i)) !== -1) {
    const head = /^@(\w+)\s*([{(])/.exec(src.slice(i));
    if (!head) {
      i++;
      continue;
    }
    const type = head[1]!.toLowerCase();
    const open = i + head[0].length - 1;
    const close = head[2] === "{" ? "}" : ")";
    let depth = 0;
    let j = open;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === head[2] || ch === "{") depth++;
      else if (ch === close || ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = src.slice(open + 1, j);
    i = j + 1;
    if (type === "comment" || type === "preamble") continue;
    if (type === "string") {
      const m = /^\s*(\w+)\s*=\s*[{"](.*)[}"]\s*$/s.exec(body);
      if (m) strings[m[1]!.toLowerCase()] = m[2]!;
      continue;
    }
    const comma = body.indexOf(",");
    if (comma < 0) {
      errors.push(`Entry @${type} has no fields.`);
      continue;
    }
    const key = body.slice(0, comma).trim();
    const fields: Record<string, string> = {};
    const fieldRe = /\s*([\w-]+)\s*=\s*/g;
    let pos = comma + 1;
    while (pos < body.length) {
      fieldRe.lastIndex = pos;
      const fm = fieldRe.exec(body);
      if (!fm || fm.index !== pos && body.slice(pos, fm.index).trim() !== "") break;
      let k = fm.index + fm[0].length;
      let value = "";
      const parts: string[] = [];
      // value := part (# part)*
      for (;;) {
        while (body[k] === " " || body[k] === "\n" || body[k] === "\t" || body[k] === "\r") k++;
        if (body[k] === "{") {
          let d = 0;
          const s0 = k;
          for (; k < body.length; k++) {
            if (body[k] === "{") d++;
            else if (body[k] === "}" && --d === 0) break;
          }
          parts.push(body.slice(s0 + 1, k));
          k++;
        } else if (body[k] === '"') {
          const s0 = ++k;
          let d = 0;
          for (; k < body.length; k++) {
            if (body[k] === "{") d++;
            else if (body[k] === "}") d--;
            else if (body[k] === '"' && d === 0) break;
          }
          parts.push(body.slice(s0, k));
          k++;
        } else {
          const m = /^[\w.-]+/.exec(body.slice(k));
          if (!m) break;
          parts.push(strings[m[0].toLowerCase()] ?? m[0]);
          k += m[0].length;
        }
        while (body[k] === " " || body[k] === "\n" || body[k] === "\t" || body[k] === "\r") k++;
        if (body[k] === "#") {
          k++;
          continue;
        }
        break;
      }
      value = parts.join("");
      fields[fm[1]!.toLowerCase()] = value;
      while (k < body.length && body[k] !== ",") k++;
      pos = k + 1;
    }
    if (!fields.title) {
      errors.push(`Entry "${key}" has no title.`);
      continue;
    }
    const names = (s?: string) => (s ? s.split(/\s+and\s+/i).map((n) => parseName(unlatex(n.trim().startsWith("{") ? n.trim() : n))) : undefined);
    const year = Number(/\d{4}/.exec(fields.year ?? fields.date ?? "")?.[0]);
    const item: CslItem = {
      id: key,
      type: BIB_TO_CSL[type] ?? "document",
      title: unlatex(fields.title),
      author: names(fields.author),
      editor: names(fields.editor),
      ...(year ? { issued: { "date-parts": [[year]] } } : {}),
      "container-title": unlatex(fields.journal ?? fields.journaltitle ?? fields.booktitle ?? "") || undefined,
      volume: fields.volume,
      issue: fields.number ?? fields.issue,
      page: fields.pages?.replace(/--/g, "–"),
      publisher: unlatex(fields.publisher ?? fields.school ?? fields.institution ?? "") || undefined,
      "publisher-place": fields.address,
      DOI: normalizeDoi(fields.doi) ?? undefined,
      URL: fields.url,
      ISBN: fields.isbn,
      ISSN: fields.issn,
      abstract: fields.abstract ? unlatex(fields.abstract) : undefined,
      edition: fields.edition,
      ...(type === "mastersthesis" ? { genre: "Master's thesis" } : type === "phdthesis" ? { genre: "PhD thesis" } : {}),
    };
    items.push(Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined && v !== "")) as CslItem);
  }
  return { items, errors };
}

const bibEscape = (s: string) => s.replace(/([&%_#$])/g, "\\$1");

export function toBibtex(items: CslItem[]): string {
  return items
    .map((it) => {
      const year = "date-parts" in (it.issued ?? {}) ? (it.issued as { "date-parts": number[][] })["date-parts"][0]?.[0] : undefined;
      const f: [string, string | undefined][] = [
        ["title", it.title ? `{${bibEscape(it.title)}}` : undefined],
        ["author", it.author?.map(nameToString).join(" and ")],
        ["editor", it.editor?.map(nameToString).join(" and ")],
        ["year", year ? String(year) : undefined],
        [it.type === "article-journal" ? "journal" : "booktitle", it["container-title"]],
        ["volume", it.volume],
        ["number", it.issue],
        ["pages", it.page?.replace(/–/g, "--")],
        ["publisher", it.publisher],
        ["address", it["publisher-place"]],
        ["edition", it.edition],
        ["doi", it.DOI],
        ["url", it.URL],
        ["isbn", it.ISBN],
      ];
      const body = f.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${k === "title" ? v!.slice(1, -1) : bibEscape(v!)}}`);
      return `@${CSL_TO_BIB[it.type] ?? "misc"}{${it.id},\n${body.join(",\n")}\n}`;
    })
    .join("\n\n")
    .concat("\n");
}

// ---------------------------------------------------------------------------
// RIS
// ---------------------------------------------------------------------------

const RIS_TO_CSL: Record<string, string> = { JOUR: "article-journal", BOOK: "book", CHAP: "chapter", CONF: "paper-conference", CPAPER: "paper-conference", THES: "thesis", RPRT: "report", ELEC: "webpage", WEB: "webpage", GEN: "document", MGZN: "article-magazine", NEWS: "article-newspaper" };
const CSL_TO_RIS: Record<string, string> = Object.fromEntries(Object.entries(RIS_TO_CSL).map(([k, v]) => [v, k]));

export function parseRis(src: string): { items: CslItem[]; errors: string[] } {
  const items: CslItem[] = [];
  const errors: string[] = [];
  let cur: Record<string, string[]> | null = null;
  let n = 0;
  for (const line of src.replace(/\r/g, "").split("\n")) {
    const m = /^([A-Z][A-Z0-9])  - ?(.*)$/.exec(line);
    if (!m) continue;
    const [, tag, value] = m as unknown as [string, string, string];
    if (tag === "TY") cur = { TY: [value.trim()] };
    else if (tag === "ER") {
      if (cur) {
        n++;
        const g = (t: string) => cur![t]?.[0]?.trim();
        const title = g("TI") ?? g("T1");
        if (!title) errors.push(`Record ${n} has no title.`);
        else {
          const year = Number(/\d{4}/.exec(g("PY") ?? g("Y1") ?? g("DA") ?? "")?.[0]);
          const sp = g("SP");
          const ep = g("EP");
          const item: CslItem = {
            id: g("ID") || `ris${n}`,
            type: RIS_TO_CSL[g("TY") ?? ""] ?? "document",
            title,
            author: [...(cur.AU ?? []), ...(cur.A1 ?? [])].map(parseName),
            editor: (cur.ED ?? cur.A2 ?? []).length ? (cur.ED ?? cur.A2 ?? []).map(parseName) : undefined,
            ...(year ? { issued: { "date-parts": [[year]] } } : {}),
            "container-title": g("JO") ?? g("JF") ?? g("T2") ?? g("BT"),
            volume: g("VL"),
            issue: g("IS"),
            page: sp ? (ep ? `${sp}–${ep}` : sp) : undefined,
            publisher: g("PB"),
            "publisher-place": g("CY"),
            DOI: normalizeDoi(g("DO")) ?? undefined,
            URL: g("UR"),
            ISBN: g("SN"),
            abstract: g("AB") ?? g("N2"),
          };
          items.push(Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length))) as CslItem);
        }
      }
      cur = null;
    } else if (cur) (cur[tag] ??= []).push(value);
  }
  return { items, errors };
}

export function toRis(items: CslItem[]): string {
  const lines: string[] = [];
  for (const it of items) {
    const year = "date-parts" in (it.issued ?? {}) ? (it.issued as { "date-parts": number[][] })["date-parts"][0]?.[0] : undefined;
    const [sp, ep] = (it.page ?? "").split(/[–-]+/);
    const push = (t: string, v?: string) => v && lines.push(`${t}  - ${v}`);
    push("TY", CSL_TO_RIS[it.type] ?? "GEN");
    push("ID", it.id);
    push("TI", it.title);
    for (const a of it.author ?? []) push("AU", nameToString(a));
    for (const e of it.editor ?? []) push("ED", nameToString(e));
    push("PY", year ? String(year) : undefined);
    push("T2", it["container-title"]);
    push("VL", it.volume);
    push("IS", it.issue);
    push("SP", sp || undefined);
    push("EP", ep || undefined);
    push("PB", it.publisher);
    push("CY", it["publisher-place"]);
    push("DO", it.DOI);
    push("UR", it.URL);
    push("SN", it.ISBN);
    push("AB", it.abstract);
    lines.push("ER  - ", "");
  }
  return lines.join("\n");
}
