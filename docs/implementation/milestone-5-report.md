# Milestone 5 report: literature and evidence

Date: 2 November 2026 · Blueprint phase 10

## What was built

**Reference library** (project → Literature → Library)
- Import BibTeX and RIS, either as a file or pasted (up to 1 MB). Duplicates are skipped by DOI or by normalised title and year.
- Add sources by hand. Export the library as BibTeX or RIS.
- Citation keys like `suri2016`, with a/b suffixes when a key is taken; keys from imported files are kept when valid.
- Bibliography preview in APA 7, Harvard (Cite Them Right), MLA 9, Chicago author-date, IEEE and Vancouver. These use citeproc-js and the official CSL styles (vendored, CC BY-SA; see `packages/citations/csl/LICENSE.md`).
- A "possible duplicates" panel for sources already in the library.

**Provenance and verification.** Each source records:
- where it came from (provider, or import/manual);
- when it was retrieved;
- what content is actually held: bibliographic details, abstract, or full text.

Its status moves through: unverified → metadata retrieved → metadata verified → full text attached → full text reviewed. Verification failure is a separate state. Every change is logged in `source_verification_events`.
- **Verified** means the title, year and first author match the DOI registry record. Software can never set a status above metadata verified.
- **Reviewed** can only be set by a person, and only when the full text is attached.

**Scholarly search** (Find sources). Searches Crossref, OpenAlex, Semantic Scholar, PubMed, Europe PMC and arXiv.
- Results come from the provider and are rate-limited per provider, with an optional contact email for the "polite" pools.
- Results are signed (HMAC) when rendered, so "metadata retrieved from Crossref" can only be recorded for data that really came back from Crossref. Signed results expire after a day.
- Gated by `research.web`.

**Full text, extraction and OCR.**
- Every stored file version (uploads, new versions, Google Drive imports) queues an extraction job on the new `files` queue.
- Extraction uses pdf.js for PDFs (per page), mammoth for DOCX, and reads plain text directly.
- Scanned PDFs fall back to poppler and Tesseract OCR when installed (`OCR_ENABLED`). The worker image now includes both.
- Files with AI processing turned off are not extracted.
- Text is stored per page in `file_passages` with a full-text index. **Search documents** shows the matching snippet with the file name and page.

**Evidence and themes.**
- An evidence record is a quote or passage, the claim it supports, and the page. It must link to a source or a file; links are checked to belong to the same project.
- It can be tied to a research question and grouped by theme. Each record shows how it was obtained (by hand, or found by AI and accepted by a person) and can be marked checked or disputed.

**Literature matrix.** One row per source: objective, method, population, findings, limitations, gap. The row's basis (what it was written from) can't exceed the content held. For example, a source with only bibliographic details can't have a row "from the full text"; this is enforced on the server and reflected in the form.

**AI agents (BYOK, as in M4).**
- *Evidence Extraction Agent:* reads the extracted text of a source's attached full text and suggests quotes.
  - Each quote is matched against the document, ignoring whitespace and quotation-mark style; quotes that don't appear in the document are discarded and counted.
  - The page is taken from the match, not from the model.
  - Accepted suggestions become evidence linked to the source and file.
  - It refuses to run without a full text, and when AI processing is off for that file; nothing is sent to the provider in either case.
- *Literature Review Agent:* drafts a thematic synthesis from the matrix and accepted evidence only.
  - Every `[@key]` citation is checked against the project library. A draft citing anything else is discarded, with the unknown keys named.
  - The draft is shown for review; it is not inserted anywhere.
- Both require edit rights and the `toolkit` entitlement. The evidence agent also needs access to project files.

## Decisions

| Decision | Reason |
|---|---|
| Verification never reaches "reviewed" automatically | "Reviewed" is a claim that a person read the paper; only a person can make it. |
| Anti-fabrication checks are deterministic code, not instructions | Prompts tell the model not to invent quotes or citations, but the guarantee comes from the verbatim match and the citation-key check after the response. |
| Search results are signed | Otherwise a crafted form post could record invented metadata with a provider's name as provenance. |
| Evidence from AI is "accepted" once a person accepts the suggestion | Accepting the suggestion is the review. "Checked against source" is a separate, later confirmation of context. |
| Full-text search uses PostgreSQL FTS, not embeddings | pgvector isn't available in this environment, and keyword search with page numbers is traceable. Semantic search can be added on the same `file_passages` table. |
| CSL files are read from disk with a fallback lookup | Inside the Next.js bundle `import.meta.url` no longer points at the package. The styles are traced into the standalone build, and the lookup also honours `CSL_DIR`. |

## Migration `0004_literature`

New tables: `references`, `source_verification_events`, `research_themes`, `evidence_records`, `literature_matrix_entries`, `file_passages` (with a generated `tsvector`). The `ai_suggestions` kind check gains `evidence` and `matrix_entry`.

## New configuration

`SCHOLARLY_CONTACT_EMAIL` (recommended), `SEMANTIC_SCHOLAR_API_KEY` (optional), `OCR_ENABLED` (default true), `CSL_DIR` (optional override).

## Tests

- `tests/literature.test.ts` (9 tests): plan gating; BibTeX and RIS round trips and duplicate detection; DOI verification including mismatches and unknown DOIs; full-text and review rules; provider normalisers for all six databases; citeproc output in all six styles; PDF text extraction and OCR of a scanned page; passage search; evidence and matrix rules.
- `tests/ai-literature.test.ts` (3 tests): verbatim-quote filtering, with a fabricated quote discarded; accepted evidence linked to the right question; refusal without a full text or with AI processing off (nothing sent to the provider); review drafts citing an unknown key rejected.
- E2E `literature.spec.ts`: upload → import BibTeX → APA and IEEE bibliographies → attach and review the full text → theme and evidence → matrix basis limits → the worker extracts text → document search finds it → BibTeX export.

**Totals:** 149 unit/integration tests and 7 E2E tests passing. Typecheck is clean and the production build succeeds.

## Not verified against the live services

The shell in this environment can't reach Crossref, OpenAlex and the other providers. The clients are tested against recorded response shapes for each provider, so run one search per provider after deploying. Provider APIs change, and the normalisers are the place to adjust.

## Known limits

- Extraction caps: 500 pages per file and 50 pages for OCR.
- The literature matrix is filled in by hand. A matrix-row agent (the `matrix_entry` suggestion kind is reserved) is a small follow-up.
- Citation insertion into documents and the citation audit arrive with the document engine (phase 11). Deleting a reference that a document cites is already blocked.
