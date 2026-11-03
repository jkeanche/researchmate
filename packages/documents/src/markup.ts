/**
 * ResearchMate section markup: a small, deterministic Markdown subset that
 * maps one-to-one onto DOCX constructs.
 *
 *   ## Heading / ### Sub-heading         (the section title is the level-1 heading)
 *   **bold**  *italic*  `code`
 *   [@key]  [@key, p. 12]  [see @a; @b, pp. 3–4]  [-@key] (suppress author)
 *   - bullet / 1. numbered
 *   > block quotation
 *   Table: Caption                       (optional line before a pipe table)
 *   | A | B |
 *   |---|---|
 *   | 1 | 2 |
 *   ![Caption](file:<file id>)           (an image uploaded to the project)
 *   $$ equation $$                       (one line, or $$ on its own lines)
 *   \newpage
 */

export type Inline = { t: "text"; v: string; b?: boolean; i?: boolean; code?: boolean } | { t: "cite"; cluster: number };

export interface CiteItem {
  key: string;
  locator?: string;
  label?: string;
  prefix?: string;
  suppressAuthor?: boolean;
}

export type Block =
  | { t: "p"; inl: Inline[] }
  | { t: "h"; level: 2 | 3; inl: Inline[] }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "quote"; inl: Inline[] }
  | { t: "table"; caption: Inline[]; rows: Inline[][][]; header: boolean }
  | { t: "figure"; fileId: string; caption: Inline[] }
  | { t: "eq"; tex: string }
  | { t: "break" };

export interface Parsed {
  blocks: Block[];
  /** Citation clusters in order of appearance; Inline.cluster indexes this array. */
  clusters: CiteItem[][];
  /** Lines that looked like markup but could not be used (e.g. a figure with a bad reference). */
  problems: string[];
}

const KEY = "[A-Za-z0-9][A-Za-z0-9_:.-]*[A-Za-z0-9_]|[A-Za-z0-9]";
const LABELS: [RegExp, string][] = [
  [/^pp?\.\s*/i, "page"],
  [/^ch(?:ap)?\.\s*/i, "chapter"],
  [/^sec(?:t)?\.\s*|^§\s*/i, "section"],
  [/^fig\.\s*/i, "figure"],
  [/^para\.\s*/i, "paragraph"],
  [/^vol\.\s*/i, "volume"],
];

/** Parses the inside of a [...] citation, e.g. "see @a, p. 3; -@b". Returns null if it isn't a citation. */
export function parseCluster(inner: string): CiteItem[] | null {
  const parts = inner.split(";").map((p) => p.trim()).filter(Boolean);
  const items: CiteItem[] = [];
  for (const part of parts) {
    const m = part.match(new RegExp(`^(.*?)(-?)@(${KEY})(?:\\s*,\\s*(.+))?$`));
    if (!m) return null;
    const [, prefix, dash, key, rest] = m;
    const item: CiteItem = { key: key! };
    if (prefix?.trim()) item.prefix = prefix.trim();
    if (dash) item.suppressAuthor = true;
    if (rest?.trim()) {
      let loc = rest.trim();
      item.label = "page";
      for (const [re, label] of LABELS) {
        if (re.test(loc)) {
          item.label = label;
          loc = loc.replace(re, "");
          break;
        }
      }
      item.locator = loc.replace(/-/g, "–");
    }
    items.push(item);
  }
  return items.length ? items : null;
}

/** Inline formatting and citations. Clusters are appended to `clusters`. */
export function parseInline(src: string, clusters: CiteItem[][]): Inline[] {
  const out: Inline[] = [];
  const push = (v: string, f: { b?: boolean; i?: boolean; code?: boolean } = {}) => {
    if (!v) return;
    const last = out.at(-1);
    if (last && last.t === "text" && !!last.b === !!f.b && !!last.i === !!f.i && !!last.code === !!f.code) last.v += v;
    else out.push({ t: "text", v, ...(f.b ? { b: true } : {}), ...(f.i ? { i: true } : {}), ...(f.code ? { code: true } : {}) });
  };
  const walk = (s: string, f: { b?: boolean; i?: boolean }) => {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "\\" && i + 1 < s.length && "*`[]\\$_".includes(s[i + 1]!)) {
        push(s[i + 1]!, f);
        i += 2;
        continue;
      }
      if (ch === "`") {
        const end = s.indexOf("`", i + 1);
        if (end > i) {
          push(s.slice(i + 1, end), { ...f, code: true });
          i = end + 1;
          continue;
        }
      }
      if (ch === "[") {
        const end = s.indexOf("]", i);
        const inner = end > i ? s.slice(i + 1, end) : "";
        if (inner.includes("@")) {
          const items = parseCluster(inner);
          if (items) {
            clusters.push(items);
            out.push({ t: "cite", cluster: clusters.length - 1 });
            i = end + 1;
            continue;
          }
        }
      }
      if (s.startsWith("**", i)) {
        const end = s.indexOf("**", i + 2);
        if (end > i + 2) {
          walk(s.slice(i + 2, end), { ...f, b: true });
          i = end + 2;
          continue;
        }
      }
      if (ch === "*" && s[i + 1] !== " ") {
        const end = s.indexOf("*", i + 1);
        if (end > i + 1 && s[end - 1] !== " ") {
          walk(s.slice(i + 1, end), { ...f, i: true });
          i = end + 1;
          continue;
        }
      }
      // Plain run up to the next special character.
      let j = i + 1;
      while (j < s.length && !"\\`[*".includes(s[j]!)) j++;
      push(s.slice(i, j), f);
      i = j;
    }
  };
  walk(src, {});
  return out;
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMarkup(src: string): Parsed {
  const clusters: CiteItem[][] = [];
  const problems: string[] = [];
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let pendingCaption: string | null = null;
  const inl = (s: string) => parseInline(s, clusters);

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    if (trimmed === "\\newpage") {
      blocks.push({ t: "break" });
      i++;
      continue;
    }
    const h = trimmed.match(/^(#{2,3})\s+(.+)$/);
    if (h) {
      blocks.push({ t: "h", level: h[1]!.length as 2 | 3, inl: inl(h[2]!.trim()) });
      i++;
      continue;
    }
    if (/^#\s/.test(trimmed)) {
      // A level-1 heading would compete with the section title; treat it as level 2.
      blocks.push({ t: "h", level: 2, inl: inl(trimmed.replace(/^#\s+/, "")) });
      i++;
      continue;
    }
    const cap = trimmed.match(/^Table:\s*(.*)$/i);
    if (cap && lines[i + 1]?.trim().startsWith("|")) {
      pendingCaption = cap[1]!;
      i++;
      continue;
    }
    if (trimmed.startsWith("|")) {
      const rows: string[][] = [];
      let header = false;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const cells = splitRow(lines[i]!);
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) header = rows.length === 1;
        else rows.push(cells);
        i++;
      }
      const width = Math.max(...rows.map((r) => r.length));
      blocks.push({ t: "table", caption: inl(pendingCaption ?? ""), header, rows: rows.map((r) => Array.from({ length: width }, (_, k) => inl(r[k] ?? ""))) });
      pendingCaption = null;
      continue;
    }
    pendingCaption = null;
    const fig = trimmed.match(/^!\[(.*)\]\((?:file:)?([^)\s]+)\)$/);
    if (fig) {
      if (UUID.test(fig[2]!)) blocks.push({ t: "figure", fileId: fig[2]!.toLowerCase(), caption: inl(fig[1]!) });
      else problems.push(`Figure “${fig[1]}” must refer to a project file (file:<id>).`);
      i++;
      continue;
    }
    if (trimmed.startsWith("$$")) {
      const oneLine = trimmed.match(/^\$\$(.+)\$\$$/);
      if (oneLine) {
        blocks.push({ t: "eq", tex: oneLine[1]!.trim() });
        i++;
        continue;
      }
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.trim() !== "$$") body.push(lines[i++]!.trim());
      i++;
      blocks.push({ t: "eq", tex: body.join(" ").trim() });
      continue;
    }
    const isBullet = (l: string) => /^\s*[-*•]\s+/.test(l);
    const isNum = (l: string) => /^\s*\d+[.)]\s+/.test(l);
    if (isBullet(line) || isNum(line)) {
      const ordered = isNum(line);
      const items: Inline[][] = [];
      while (i < lines.length && (ordered ? isNum(lines[i]!) : isBullet(lines[i]!))) {
        items.push(inl(lines[i]!.replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/, "").trim()));
        i++;
      }
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    if (trimmed.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) body.push(lines[i++]!.trim().replace(/^>\s?/, ""));
      blocks.push({ t: "quote", inl: inl(body.join(" ")) });
      continue;
    }
    // Paragraph: consecutive plain lines.
    const body: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      const t = l.trim();
      if (!t || /^(#{1,3}\s|\||>|\$\$|!\[|\\newpage$)/.test(t) || isBullet(l) || isNum(l) || (/^Table:/i.test(t) && lines[i + 1]?.trim().startsWith("|"))) break;
      body.push(t);
      i++;
    }
    blocks.push({ t: "p", inl: inl(body.join(" ")) });
  }
  return { blocks, clusters, problems };
}

/** Plain text of inlines (citations omitted). */
export const inlineText = (inl: Inline[]) => inl.map((x) => (x.t === "text" ? x.v : "")).join("");

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * Words in running text: paragraphs, headings, lists and quotations.
 * Citations, tables, figure captions and equations are not counted (the
 * usual convention for thesis word limits).
 */
export function countWords(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.t === "p" || b.t === "h" || b.t === "quote") n += words(inlineText(b.inl));
    else if (b.t === "list") n += b.items.reduce((a, it) => a + words(inlineText(it)), 0);
  }
  return n;
}
