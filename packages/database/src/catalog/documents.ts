/**
 * Document templates (seed data). A document copies its template's
 * specification when created, as specification version 1; later template
 * versions never change existing documents.
 *
 * Fonts are named as authors expect (Times New Roman, Calibri). The PDF
 * renderer uses metric-compatible substitutes (Liberation Serif, Carlito)
 * when the originals are not installed, so line breaks and page counts match.
 */

export type SectionKind = "title" | "front" | "toc" | "body" | "references" | "appendix";

export interface SectionSpec {
  key: string;
  title: string;
  kind: SectionKind;
  required: boolean;
  wordLimit?: number | null;
  guidance?: string;
}

export interface DocumentSpec {
  page: { size: "A4" | "Letter"; marginsMm: { top: number; bottom: number; left: number; right: number } };
  font: { family: string; sizePt: number };
  headingFont: string;
  /** Line spacing multiple: 1, 1.15, 1.5, 2. */
  lineSpacing: number;
  paragraph: { spaceBeforePt: number; spaceAfterPt: number; firstLineIndentMm: number };
  headingNumbering: boolean;
  pageNumbers: { position: "bottom-center" | "bottom-right" | "top-right" | "none"; prelims: "roman" | "none" };
  header: string;
  footer: string;
  citationStyle: "apa7" | "harvard" | "mla" | "chicago" | "ieee" | "vancouver";
  limits: { minWords: number | null; maxWords: number | null; maxPages: number | null; abstractMaxWords: number | null };
  titlePage: boolean;
  captions: { table: "above" | "below"; figure: "above" | "below" };
  sections: SectionSpec[];
}

export interface DocumentTemplateSeed {
  key: string;
  version: number;
  name: string;
  documentType: "undergraduate_project" | "masters_dissertation" | "phd_thesis" | "journal_article" | "conference_paper" | "proposal" | "report" | "custom";
  description: string;
  spec: DocumentSpec;
}

const A4 = (top = 25, bottom = 25, left = 30, right = 25) => ({ size: "A4" as const, marginsMm: { top, bottom, left, right } });
const s = (key: string, title: string, kind: SectionKind, required = true, extra: Partial<SectionSpec> = {}): SectionSpec => ({ key, title, kind, required, ...extra });

const thesisBase = (lineSpacing: number): Omit<DocumentSpec, "limits" | "sections"> => ({
  page: A4(),
  font: { family: "Times New Roman", sizePt: 12 },
  headingFont: "Times New Roman",
  lineSpacing,
  paragraph: { spaceBeforePt: 0, spaceAfterPt: 6, firstLineIndentMm: 0 },
  headingNumbering: true,
  pageNumbers: { position: "bottom-center", prelims: "roman" },
  header: "",
  footer: "",
  citationStyle: "apa7",
  titlePage: true,
  captions: { table: "above", figure: "below" },
});

const chapters = (extra: SectionSpec[] = []): SectionSpec[] => [
  s("introduction", "Introduction", "body", true, { guidance: "Background, problem statement, research questions and objectives, significance, scope." }),
  s("literature_review", "Literature Review", "body", true, { guidance: "Themes from the literature, debates, and the gap this study addresses." }),
  s("methodology", "Methodology", "body", true, { guidance: "Design, population and sampling, data collection, analysis, ethics." }),
  s("results", "Results", "body", true),
  s("discussion", "Discussion", "body", true),
  ...extra,
  s("conclusion", "Conclusion and Recommendations", "body", true),
];

export const DOCUMENT_TEMPLATE_SEEDS: DocumentTemplateSeed[] = [
  {
    key: "undergraduate_project",
    version: 1,
    name: "Undergraduate project",
    documentType: "undergraduate_project",
    description: "Final-year project report: about 10,000 words, 1.5 line spacing, APA 7.",
    spec: {
      ...thesisBase(1.5),
      limits: { minWords: 8000, maxWords: 12000, maxPages: null, abstractMaxWords: 300 },
      sections: [s("title", "Title page", "title"), s("abstract", "Abstract", "front", true, { wordLimit: 300 }), s("acknowledgements", "Acknowledgements", "front", false), s("toc", "Contents", "toc"), ...chapters(), s("references", "References", "references"), s("appendices", "Appendices", "appendix", false)],
    },
  },
  {
    key: "masters_dissertation",
    version: 1,
    name: "Master's dissertation",
    documentType: "masters_dissertation",
    description: "15,000–20,000 words, 1.5 line spacing, declaration and abstract, APA 7.",
    spec: {
      ...thesisBase(1.5),
      limits: { minWords: 15000, maxWords: 20000, maxPages: null, abstractMaxWords: 350 },
      sections: [
        s("title", "Title page", "title"),
        s("declaration", "Declaration", "front", true, { guidance: "Statement that the work is your own and has not been submitted elsewhere." }),
        s("abstract", "Abstract", "front", true, { wordLimit: 350 }),
        s("acknowledgements", "Acknowledgements", "front", false),
        s("toc", "Contents", "toc"),
        ...chapters(),
        s("references", "References", "references"),
        s("appendices", "Appendices", "appendix", false),
      ],
    },
  },
  {
    key: "phd_thesis",
    version: 1,
    name: "PhD thesis",
    documentType: "phd_thesis",
    description: "Up to 100,000 words, double spacing, declaration, abstract and chapters, APA 7.",
    spec: {
      ...thesisBase(2),
      limits: { minWords: 60000, maxWords: 100000, maxPages: null, abstractMaxWords: 500 },
      sections: [
        s("title", "Title page", "title"),
        s("declaration", "Declaration", "front", true),
        s("abstract", "Abstract", "front", true, { wordLimit: 500 }),
        s("acknowledgements", "Acknowledgements", "front", false),
        s("abbreviations", "Abbreviations", "front", false),
        s("toc", "Contents", "toc"),
        ...chapters([s("contribution", "Contribution to Knowledge", "body", false)]),
        s("references", "References", "references"),
        s("appendices", "Appendices", "appendix", false),
      ],
    },
  },
  {
    key: "journal_article",
    version: 1,
    name: "Journal article (manuscript)",
    documentType: "journal_article",
    description: "Manuscript for submission: up to 8,000 words, double spacing, unnumbered headings, 250-word abstract.",
    spec: {
      ...thesisBase(2),
      page: A4(25, 25, 25, 25),
      headingNumbering: false,
      pageNumbers: { position: "bottom-right", prelims: "none" },
      titlePage: false,
      limits: { minWords: null, maxWords: 8000, maxPages: null, abstractMaxWords: 250 },
      sections: [
        s("title", "Title", "title"),
        s("abstract", "Abstract", "front", true, { wordLimit: 250 }),
        s("keywords", "Keywords", "front", false, { wordLimit: 40, guidance: "Four to six keywords, separated by semicolons." }),
        s("introduction", "Introduction", "body"),
        s("methods", "Methods", "body"),
        s("results", "Results", "body"),
        s("discussion", "Discussion", "body"),
        s("conclusion", "Conclusion", "body", false),
        s("references", "References", "references"),
        s("appendices", "Supplementary material", "appendix", false),
      ],
    },
  },
  {
    key: "conference_paper",
    version: 1,
    name: "Conference paper",
    documentType: "conference_paper",
    description: "Short paper: 8-page limit, 10 pt single spacing, numbered headings, IEEE citations.",
    spec: {
      page: A4(19, 19, 19, 19),
      font: { family: "Times New Roman", sizePt: 10 },
      headingFont: "Times New Roman",
      lineSpacing: 1,
      paragraph: { spaceBeforePt: 0, spaceAfterPt: 4, firstLineIndentMm: 4 },
      headingNumbering: true,
      pageNumbers: { position: "bottom-center", prelims: "none" },
      header: "",
      footer: "",
      citationStyle: "ieee",
      titlePage: false,
      captions: { table: "above", figure: "below" },
      limits: { minWords: null, maxWords: null, maxPages: 8, abstractMaxWords: 200 },
      sections: [
        s("title", "Title", "title"),
        s("abstract", "Abstract", "front", true, { wordLimit: 200 }),
        s("introduction", "Introduction", "body"),
        s("related_work", "Related Work", "body", false),
        s("method", "Method", "body"),
        s("results", "Results", "body"),
        s("conclusion", "Conclusion", "body"),
        s("references", "References", "references"),
      ],
    },
  },
  {
    key: "research_proposal",
    version: 1,
    name: "Research proposal",
    documentType: "proposal",
    description: "Proposal for approval or funding: up to 5,000 words, 1.5 spacing, with timeline and budget.",
    spec: {
      ...thesisBase(1.5),
      limits: { minWords: null, maxWords: 5000, maxPages: null, abstractMaxWords: 300 },
      sections: [
        s("title", "Title page", "title"),
        s("abstract", "Summary", "front", true, { wordLimit: 300 }),
        s("toc", "Contents", "toc"),
        s("background", "Background", "body"),
        s("problem", "Problem Statement", "body"),
        s("objectives", "Research Questions and Objectives", "body"),
        s("literature_review", "Literature Review", "body"),
        s("methodology", "Methodology", "body"),
        s("ethics", "Ethical Considerations", "body"),
        s("timeline", "Work Plan and Timeline", "body"),
        s("budget", "Budget", "body", false),
        s("references", "References", "references"),
        s("appendices", "Appendices", "appendix", false),
      ],
    },
  },
  {
    key: "research_report",
    version: 1,
    name: "Research report",
    documentType: "report",
    description: "Report for partners or funders: Calibri 11, executive summary, findings and recommendations.",
    spec: {
      page: A4(25, 25, 25, 25),
      font: { family: "Calibri", sizePt: 11 },
      headingFont: "Calibri",
      lineSpacing: 1.15,
      paragraph: { spaceBeforePt: 0, spaceAfterPt: 8, firstLineIndentMm: 0 },
      headingNumbering: true,
      pageNumbers: { position: "bottom-right", prelims: "roman" },
      header: "",
      footer: "",
      citationStyle: "harvard",
      titlePage: true,
      captions: { table: "above", figure: "below" },
      limits: { minWords: null, maxWords: null, maxPages: null, abstractMaxWords: 600 },
      sections: [
        s("title", "Title page", "title"),
        s("summary", "Executive Summary", "front", true, { wordLimit: 600 }),
        s("toc", "Contents", "toc"),
        s("introduction", "Introduction", "body"),
        s("methods", "Approach", "body"),
        s("findings", "Findings", "body"),
        s("recommendations", "Recommendations", "body"),
        s("references", "References", "references"),
        s("appendices", "Appendices", "appendix", false),
      ],
    },
  },
  {
    key: "custom",
    version: 1,
    name: "Custom document",
    documentType: "custom",
    description: "A blank structure to adapt: add and rename sections and set your own formatting.",
    spec: {
      ...thesisBase(1.5),
      headingNumbering: false,
      titlePage: false,
      pageNumbers: { position: "bottom-center", prelims: "none" },
      limits: { minWords: null, maxWords: null, maxPages: null, abstractMaxWords: null },
      sections: [s("title", "Title", "title"), s("introduction", "Introduction", "body"), s("main", "Main Text", "body"), s("conclusion", "Conclusion", "body", false), s("references", "References", "references")],
    },
  },
];
