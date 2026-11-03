import { type CslItem, type CslName, normalizeDoi, parseName } from "@researchmate/citations";

/**
 * Scholarly search adapters. Each normalises a provider's response into a
 * ScholarlyRecord with provenance (provider, external id, retrieval time) and
 * an honest statement of what was retrieved: metadata only, or an abstract.
 * Full text is never claimed from a search result.
 */

export const PROVIDERS = {
  crossref: "Crossref",
  openalex: "OpenAlex",
  semantic_scholar: "Semantic Scholar",
  pubmed: "PubMed",
  europe_pmc: "Europe PMC",
  arxiv: "arXiv",
} as const;
export type ProviderKey = keyof typeof PROVIDERS;

export interface ScholarlyRecord {
  provider: ProviderKey;
  externalId: string;
  doi: string | null;
  title: string;
  authors: CslName[];
  year: number | null;
  venue: string | null;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  abstract: string | null;
  url: string | null;
  openAccessUrl: string | null;
  type: string;
  access: "metadata" | "abstract";
  retrievedAt: string;
}

export interface SearchPage {
  records: ScholarlyRecord[];
  total: number | null;
  nextCursor: string | null;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ScholarlyOptions {
  fetch?: Fetcher;
  /** Contact email sent to Crossref/OpenAlex/NCBI ("polite pool"), from SCHOLARLY_CONTACT_EMAIL. */
  contactEmail?: string;
  semanticScholarKey?: string;
  /** Minimum milliseconds between requests to one provider (rate limiting). */
  minIntervalMs?: number;
  baseUrls?: Partial<Record<ProviderKey | "doi", string>>;
}

const BASE: Record<ProviderKey | "doi", string> = {
  crossref: "https://api.crossref.org",
  openalex: "https://api.openalex.org",
  semantic_scholar: "https://api.semanticscholar.org/graph/v1",
  pubmed: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils",
  europe_pmc: "https://www.ebi.ac.uk/europepmc/webservices/rest",
  arxiv: "https://export.arxiv.org/api",
  doi: "https://doi.org",
};

const CROSSREF_TYPES: Record<string, string> = { "journal-article": "article-journal", "book-chapter": "chapter", book: "book", "proceedings-article": "paper-conference", dissertation: "thesis", report: "report", "posted-content": "article", dataset: "dataset" };
const stripTags = (s: string | undefined | null) => (s ? s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null);
const clean = (s: unknown) => (typeof s === "string" && s.trim() ? s.trim() : undefined);

export class ScholarlyClient {
  private readonly fetcher: Fetcher;
  private readonly base: Record<ProviderKey | "doi", string>;
  private readonly last = new Map<string, number>();

  constructor(private readonly opts: ScholarlyOptions = {}) {
    this.fetcher = opts.fetch ?? ((u, i) => fetch(u, i));
    this.base = { ...BASE, ...opts.baseUrls };
  }

  private async get(provider: ProviderKey | "doi", url: string, init: RequestInit = {}): Promise<Response> {
    const gap = this.opts.minIntervalMs ?? 0;
    const wait = (this.last.get(provider) ?? 0) + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last.set(provider, Date.now());
    const headers: Record<string, string> = { accept: "application/json", "user-agent": `ResearchMate/1.0${this.opts.contactEmail ? ` (mailto:${this.opts.contactEmail})` : ""}`, ...(init.headers as Record<string, string>) };
    const res = await this.fetcher(url, { ...init, headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) throw new ProviderError(provider, "The provider's rate limit was reached. Try again in a minute.", true);
    if (!res.ok && res.status !== 404) throw new ProviderError(provider, `${PROVIDERS[provider as ProviderKey] ?? provider} returned an error (${res.status}).`, res.status >= 500);
    return res;
  }

  async search(provider: ProviderKey, query: string, opts: { cursor?: string | null; pageSize?: number } = {}): Promise<SearchPage> {
    const q = query.trim().slice(0, 300);
    const size = Math.min(Math.max(opts.pageSize ?? 20, 1), 50);
    const offset = Number(opts.cursor ?? 0) || 0;
    const now = new Date().toISOString();
    const mail = this.opts.contactEmail ? `&mailto=${encodeURIComponent(this.opts.contactEmail)}` : "";
    switch (provider) {
      case "crossref": {
        const r = await (await this.get(provider, `${this.base.crossref}/works?query=${encodeURIComponent(q)}&rows=${size}&offset=${offset}${mail}`)).json();
        const items = (r.message?.items ?? []) as Record<string, unknown>[];
        return { records: items.map((i) => fromCrossref(i, now)).filter((x): x is ScholarlyRecord => !!x), total: r.message?.["total-results"] ?? null, nextCursor: offset + size < (r.message?.["total-results"] ?? 0) ? String(offset + size) : null };
      }
      case "openalex": {
        const page = Math.floor(offset / size) + 1;
        const r = await (await this.get(provider, `${this.base.openalex}/works?search=${encodeURIComponent(q)}&per-page=${size}&page=${page}${mail}`)).json();
        const items = (r.results ?? []) as Record<string, unknown>[];
        const total = r.meta?.count ?? null;
        return { records: items.map((i) => fromOpenAlex(i, now)).filter((x): x is ScholarlyRecord => !!x), total, nextCursor: total !== null && offset + size < total ? String(offset + size) : null };
      }
      case "semantic_scholar": {
        const fields = "title,authors,year,venue,externalIds,abstract,url,openAccessPdf,publicationTypes,journal";
        const r = await (await this.get(provider, `${this.base.semantic_scholar}/paper/search?query=${encodeURIComponent(q)}&offset=${offset}&limit=${size}&fields=${fields}`, this.opts.semanticScholarKey ? { headers: { "x-api-key": this.opts.semanticScholarKey } } : {})).json();
        const items = (r.data ?? []) as Record<string, unknown>[];
        return { records: items.map((i) => fromSemanticScholar(i, now)).filter((x): x is ScholarlyRecord => !!x), total: r.total ?? null, nextCursor: r.next != null ? String(r.next) : null };
      }
      case "pubmed": {
        const tool = `&tool=researchmate${this.opts.contactEmail ? `&email=${encodeURIComponent(this.opts.contactEmail)}` : ""}`;
        const s = await (await this.get(provider, `${this.base.pubmed}/esearch.fcgi?db=pubmed&retmode=json&term=${encodeURIComponent(q)}&retstart=${offset}&retmax=${size}${tool}`)).json();
        const ids: string[] = s.esearchresult?.idlist ?? [];
        const total = Number(s.esearchresult?.count ?? 0);
        if (!ids.length) return { records: [], total, nextCursor: null };
        const d = await (await this.get(provider, `${this.base.pubmed}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}${tool}`)).json();
        return { records: ids.map((id) => fromPubmed(d.result?.[id], now)).filter((x): x is ScholarlyRecord => !!x), total, nextCursor: offset + size < total ? String(offset + size) : null };
      }
      case "europe_pmc": {
        const page = Math.floor(offset / size) + 1;
        const r = await (await this.get(provider, `${this.base.europe_pmc}/search?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=${size}&page=${page}`)).json();
        const items = (r.resultList?.result ?? []) as Record<string, unknown>[];
        const total = r.hitCount ?? null;
        return { records: items.map((i) => fromEuropePmc(i, now)).filter((x): x is ScholarlyRecord => !!x), total, nextCursor: total !== null && offset + size < total ? String(offset + size) : null };
      }
      case "arxiv": {
        const xml = await (await this.get(provider, `${this.base.arxiv}/query?search_query=all:${encodeURIComponent(q)}&start=${offset}&max_results=${size}`, { headers: { accept: "application/atom+xml" } })).text();
        const total = Number(/<opensearch:totalResults[^>]*>(\d+)/.exec(xml)?.[1] ?? 0);
        return { records: parseArxiv(xml, now), total, nextCursor: offset + size < total ? String(offset + size) : null };
      }
    }
  }

  /** Authoritative metadata for a DOI (Crossref first, then DOI content negotiation). Null if the DOI is unknown. */
  async resolveDoi(doiIn: string): Promise<ScholarlyRecord | null> {
    const doi = normalizeDoi(doiIn);
    if (!doi) return null;
    const now = new Date().toISOString();
    const mail = this.opts.contactEmail ? `?mailto=${encodeURIComponent(this.opts.contactEmail)}` : "";
    const res = await this.get("crossref", `${this.base.crossref}/works/${encodeURIComponent(doi)}${mail}`);
    if (res.ok) {
      const r = await res.json();
      const rec = fromCrossref(r.message ?? {}, now);
      if (rec) return rec;
    }
    const cn = await this.get("doi", `${this.base.doi}/${encodeURIComponent(doi)}`, { headers: { accept: "application/vnd.citationstyles.csl+json" } });
    if (!cn.ok) return null;
    const c = (await cn.json()) as CslItem & { issued?: { "date-parts": number[][] } };
    return { provider: "crossref", externalId: doi, doi, title: String(c.title ?? ""), authors: c.author ?? [], year: (c.issued as { "date-parts": number[][] } | undefined)?.["date-parts"]?.[0]?.[0] ?? null, venue: clean(c["container-title"]) ?? null, abstract: stripTags(c.abstract as string | undefined), url: `https://doi.org/${doi}`, openAccessUrl: null, type: c.type ?? "article-journal", access: c.abstract ? "abstract" : "metadata", retrievedAt: now };
  }
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

// ----- Normalisers (exported for tests) -------------------------------------

export function fromCrossref(i: Record<string, unknown>, now: string): ScholarlyRecord | null {
  const title = (i.title as string[] | undefined)?.[0];
  if (!title) return null;
  const doi = normalizeDoi(i.DOI as string);
  const issued = ((i.issued ?? i["published-print"] ?? i["published-online"]) as { "date-parts"?: number[][] } | undefined)?.["date-parts"]?.[0]?.[0];
  const abstract = stripTags(i.abstract as string | undefined);
  return {
    provider: "crossref",
    externalId: doi ?? String(i.URL ?? title),
    doi,
    title: stripTags(title)!,
    authors: ((i.author as { given?: string; family?: string; name?: string }[] | undefined) ?? []).map((a) => (a.family ? { family: a.family, given: a.given } : { literal: a.name ?? "" })),
    year: issued ?? null,
    venue: (i["container-title"] as string[] | undefined)?.[0] ?? null,
    volume: clean(i.volume),
    issue: clean(i.issue),
    pages: clean(i.page),
    publisher: clean(i.publisher),
    abstract,
    url: doi ? `https://doi.org/${doi}` : clean(i.URL) ?? null,
    openAccessUrl: null,
    type: CROSSREF_TYPES[String(i.type)] ?? "article-journal",
    access: abstract ? "abstract" : "metadata",
    retrievedAt: now,
  };
}

/** OpenAlex stores abstracts as an inverted index (word → positions). */
export function invertedIndexToText(idx: Record<string, number[]> | null | undefined): string | null {
  if (!idx) return null;
  const words: string[] = [];
  for (const [w, positions] of Object.entries(idx)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(" ") || null;
}

export function fromOpenAlex(i: Record<string, unknown>, now: string): ScholarlyRecord | null {
  const title = clean(i.title) ?? clean(i.display_name);
  if (!title) return null;
  const doi = normalizeDoi(i.doi as string);
  const biblio = (i.biblio ?? {}) as Record<string, string | null>;
  const abstract = invertedIndexToText(i.abstract_inverted_index as Record<string, number[]> | null);
  const loc = (i.primary_location ?? {}) as { source?: { display_name?: string; host_organization_name?: string }; landing_page_url?: string };
  return {
    provider: "openalex",
    externalId: String(i.id ?? doi ?? title).replace("https://openalex.org/", ""),
    doi,
    title,
    authors: ((i.authorships as { author?: { display_name?: string } }[] | undefined) ?? []).map((a) => parseName(a.author?.display_name ?? "")).filter((a) => a.family || a.literal),
    year: (i.publication_year as number | undefined) ?? null,
    venue: loc.source?.display_name ?? null,
    volume: clean(biblio.volume),
    issue: clean(biblio.issue),
    pages: biblio.first_page ? (biblio.last_page ? `${biblio.first_page}–${biblio.last_page}` : biblio.first_page) : undefined,
    publisher: clean(loc.source?.host_organization_name),
    abstract,
    url: doi ? `https://doi.org/${doi}` : clean(loc.landing_page_url) ?? null,
    openAccessUrl: clean((i.open_access as { oa_url?: string } | undefined)?.oa_url) ?? null,
    type: i.type === "book" ? "book" : i.type === "book-chapter" ? "chapter" : i.type === "dissertation" ? "thesis" : "article-journal",
    access: abstract ? "abstract" : "metadata",
    retrievedAt: now,
  };
}

export function fromSemanticScholar(i: Record<string, unknown>, now: string): ScholarlyRecord | null {
  const title = clean(i.title);
  if (!title) return null;
  const ext = (i.externalIds ?? {}) as Record<string, string>;
  const doi = normalizeDoi(ext.DOI);
  const journal = (i.journal ?? {}) as { name?: string; volume?: string; pages?: string };
  const abstract = clean(i.abstract) ?? null;
  return {
    provider: "semantic_scholar",
    externalId: String(i.paperId ?? ext.CorpusId ?? title),
    doi,
    title,
    authors: ((i.authors as { name?: string }[] | undefined) ?? []).map((a) => parseName(a.name ?? "")),
    year: (i.year as number | undefined) ?? null,
    venue: clean(journal.name) ?? clean(i.venue) ?? null,
    volume: clean(journal.volume),
    pages: clean(journal.pages)?.replace(/\s/g, ""),
    abstract,
    url: doi ? `https://doi.org/${doi}` : clean(i.url) ?? null,
    openAccessUrl: clean((i.openAccessPdf as { url?: string } | null)?.url) ?? null,
    type: ((i.publicationTypes as string[] | null) ?? []).includes("Conference") ? "paper-conference" : "article-journal",
    access: abstract ? "abstract" : "metadata",
    retrievedAt: now,
  };
}

export function fromPubmed(d: Record<string, unknown> | undefined, now: string): ScholarlyRecord | null {
  if (!d || !clean(d.title)) return null;
  const ids = (d.articleids as { idtype: string; value: string }[] | undefined) ?? [];
  const doi = normalizeDoi(ids.find((x) => x.idtype === "doi")?.value);
  const year = Number(/\d{4}/.exec(String(d.pubdate ?? ""))?.[0]) || null;
  return {
    provider: "pubmed",
    externalId: String(d.uid),
    doi,
    title: String(d.title).replace(/\.$/, ""),
    // PubMed summary names look like "Smith JA".
    authors: ((d.authors as { name: string; authtype?: string }[] | undefined) ?? []).filter((a) => !a.authtype || a.authtype === "Author").map((a) => {
      const m = /^(.*?)\s+([A-Z]{1,3})$/.exec(a.name);
      return m ? { family: m[1], given: m[2]!.split("").join(". ") + "." } : { literal: a.name };
    }),
    year,
    venue: clean(d.fulljournalname) ?? clean(d.source) ?? null,
    volume: clean(d.volume),
    issue: clean(d.issue),
    pages: clean(d.pages),
    abstract: null, // esummary has no abstracts; marked metadata-only
    url: `https://pubmed.ncbi.nlm.nih.gov/${String(d.uid)}/`,
    openAccessUrl: null,
    type: "article-journal",
    access: "metadata",
    retrievedAt: now,
  };
}

export function fromEuropePmc(i: Record<string, unknown>, now: string): ScholarlyRecord | null {
  const title = clean(i.title)?.replace(/\.$/, "");
  if (!title) return null;
  const doi = normalizeDoi(i.doi as string);
  const authorList = ((i.authorList as { author?: { lastName?: string; firstName?: string; fullName?: string }[] } | undefined)?.author ?? []).map((a) => (a.lastName ? { family: a.lastName, given: a.firstName } : { literal: a.fullName ?? "" }));
  const authors = authorList.length ? authorList : String(i.authorString ?? "").split(/,\s*/).filter(Boolean).map((n) => {
    const m = /^(.*?)\s+([A-Z]{1,3})\.?$/.exec(n.trim());
    return m ? { family: m[1], given: m[2]!.split("").join(". ") + "." } : { literal: n.trim() };
  });
  const abstract = stripTags(i.abstractText as string | undefined);
  const ft = ((i.fullTextUrlList as { fullTextUrl?: { availability?: string; url?: string; documentStyle?: string }[] } | undefined)?.fullTextUrl ?? []).find((u) => u.availability === "Open access" || u.availability === "Free");
  return {
    provider: "europe_pmc",
    externalId: `${String(i.source ?? "MED")}:${String(i.id ?? i.pmid ?? title)}`,
    doi,
    title,
    authors,
    year: Number(i.pubYear) || null,
    venue: clean((i.journalInfo as { journal?: { title?: string } } | undefined)?.journal?.title) ?? clean(i.journalTitle) ?? null,
    volume: clean(i.journalVolume) ?? clean((i.journalInfo as { volume?: string } | undefined)?.volume),
    issue: clean(i.issue) ?? clean((i.journalInfo as { issue?: string } | undefined)?.issue),
    pages: clean(i.pageInfo),
    abstract,
    url: doi ? `https://doi.org/${doi}` : i.pmid ? `https://europepmc.org/article/MED/${String(i.pmid)}` : null,
    openAccessUrl: ft?.url ?? null,
    type: "article-journal",
    access: abstract ? "abstract" : "metadata",
    retrievedAt: now,
  };
}

const xmlText = (s: string | undefined) => (s ? s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() : "");

export function parseArxiv(xml: string, now: string): ScholarlyRecord[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const e = m[1]!;
    const tag = (t: string) => xmlText(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(e)?.[1]);
    const id = tag("id");
    const doi = normalizeDoi(tag("arxiv:doi"));
    const pdf = /<link[^>]*title="pdf"[^>]*href="([^"]+)"/.exec(e)?.[1] ?? /<link[^>]*href="([^"]+)"[^>]*title="pdf"/.exec(e)?.[1] ?? null;
    const abstract = tag("summary") || null;
    return {
      provider: "arxiv" as const,
      externalId: id.replace(/^https?:\/\/arxiv\.org\/abs\//, ""),
      doi,
      title: tag("title"),
      authors: [...e.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map((a) => parseName(xmlText(a[1]))),
      year: Number(tag("published").slice(0, 4)) || null,
      venue: tag("arxiv:journal_ref") || "arXiv",
      abstract,
      url: id || null,
      openAccessUrl: pdf,
      type: "article",
      access: abstract ? ("abstract" as const) : ("metadata" as const),
      retrievedAt: now,
    };
  }).filter((r) => r.title);
}

/** A ScholarlyRecord as a CSL item for the reference library. */
export function recordToCsl(r: ScholarlyRecord, id: string): CslItem {
  return Object.fromEntries(
    Object.entries({
      id,
      type: r.type,
      title: r.title,
      author: r.authors.length ? r.authors : undefined,
      issued: r.year ? { "date-parts": [[r.year]] } : undefined,
      "container-title": r.venue ?? undefined,
      volume: r.volume,
      issue: r.issue,
      page: r.pages,
      publisher: r.publisher,
      DOI: r.doi ?? undefined,
      URL: r.url ?? undefined,
      abstract: r.abstract ?? undefined,
    }).filter(([, v]) => v !== undefined),
  ) as CslItem;
}
