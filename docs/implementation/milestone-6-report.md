# Milestone 6 report: document engine

Date: 2 November 2026 · Blueprint phase 11

## What was built

**Templates (versioned).** Undergraduate project, Master's dissertation, PhD thesis, journal article (manuscript), conference paper, research proposal, research report and custom.
- Each template is a full specification: page size and margins, fonts and sizes, line and paragraph spacing, heading numbering, page numbering (roman preliminary pages), header and footer, citation style, word/page/abstract limits, title page, caption positions, and the required and optional sections with guidance and per-section limits.
- Templates are seeded per (key, version) and never edited in place. A document copies its template's specification as specification version 1.
- Changing formatting or limits creates a new, append-only specification version with an optional reason. Each export records the version it used.

**Structured editor** (Write tab).
- One editor per section: preliminary pages, chapters and appendices. The title page, contents and reference list are generated.
- The markup is a small Markdown subset that maps one-to-one onto Word constructs: headings to three levels, bold and italic, lists, block quotations, captioned tables, figures (PNG/JPEG project files), numbered equations with common TeX symbols, page breaks.
- Citations: `[@key]`, `[@key, p. 12]`, `[see @a; @b]` and `[-@key]`. A citation picker shows the project library.
- Live word counts per section and for the main text, against the limits.
- Saves use optimistic concurrency: a stale save is refused, never overwritten. Autosave runs after 20 seconds, and on switching sections. Ctrl+S saves. There is a warning before leaving with unsaved text.
- Comments per section, with quotation, replies, resolve and reopen. Researchers and supervisors can comment; supervisors can't edit.
- Evidence from the Literature tab can be linked to a section and inserted as a cited quotation.
- Sections can be added, renamed, given word limits, reordered within their kind, and removed (only when optional and empty).

**Versions.** Snapshots of every section, append-only (database trigger). Restoring first saves the current text as a version, so nothing is lost. Every export snapshots the document first, so later edits never change an export.

**Citations.**
- citeproc-js with the six vendored CSL styles: in-text citations formatted per document (numbering and disambiguation correct) and a generated reference list.
- `document_citations` indexes every citation on save.
- **Every citation must point to a library record:** unknown keys are highlighted in the preview and block export, naming the keys.
- **Citation audit:** each cited source with its sections, count, verification status and the content actually held. Flagged: unknown keys, failed or missing verification, sources cited from bibliographic details only, library sources never cited, and linked evidence whose source isn't cited in that section.

**DOCX (editable master).** Built with `docx` 9.10:
- real heading styles with outline levels (so Word's navigation and contents work);
- a table-of-contents field;
- Word sections with roman then arabic page numbering;
- fixed-layout tables sized to the text width;
- scaled figures, numbered captions, a hanging-indent reference list.

**PDF with a real renderer.**
- LibreOffice converts the DOCX in a throwaway profile per job. A Python-UNO script updates the table of contents (twice, since filling it can move headings) before exporting.
- The PDF is then read back with pdf.js: page sizes, positioned text and image bounding boxes, the latter tracked through the PDF transformation matrix.

**Validation of the actual output.** Every export stores its results (`document_validation_results`). Content checks are also shown live on the Checks tab.

| Check | How |
|---|---|
| Required sections | Required preliminary and main-text sections have content |
| Word limits | Main-text words against minimum and maximum; abstract and per-section limits. Citations, tables, captions, equations, references and appendices are excluded, and the rule is stated |
| Citations | All resolve to library records; verification status of cited sources |
| Figures | Every figure file exists in the project and is PNG or JPEG |
| Page size | Every PDF page matches A4 or Letter |
| Page count | Against the page limit |
| Margins | No text or image extends past the left or right margin or off the page |
| Headings | Every heading, with its number, appears in the body in order |
| Contents | The contents page lists the chapters |
| Tables and figures | Each table caption appears, and an image is drawn for each figure |
| Page numbers | The expected number is printed in the footer (or header) band of every page: roman on preliminary pages, arabic from the main text |
| Blank pages | Reported |

**Background export.**
- The `documents` queue runs in the worker; the page refreshes while rendering. Downloads stream through an access-checked route.
- The last 10 exports per document are kept.
- Export requires the `documents.generation` entitlement (Starter and above). Writing, preview and checks are available on every plan.

**UI.** A Documents tab per project, with each document split into Write, Preview, Checks & citations, Versions & export, and Specification.

## Found by testing

- **The validator caught a real rendering defect.** Without an explicit line rule, LibreOffice clipped inline images to one line height, so a figure printed as a thin strip. The margin check reported the image as running off the page. Every paragraph style now sets automatic line spacing.
- The contents page was empty until heading styles carried outline levels, and its own heading was listed inside it until it got a separate style.
- Empty optional sections were printed with blank pages; they are now left out (and kept out of numbering and the contents).
- E2E found two problems: switching sections could leave typed text unsaved, so the editor now saves on the way out; and my test typed into the previous section before navigation finished.

## Tests

- `tests/documents.test.ts` (9 tests):
  - markup parsing and citation clusters, TeX symbols, numbering and word counting;
  - overflow detection on synthetic pages;
  - specification versions and their append-only trigger;
  - optimistic concurrency, citation index, audit, a cited reference blocked from deletion, versions and restore, section rules;
  - plan gating and unknown-key blocking, supervisor comments, finance roles and outsiders refused;
  - evidence links;
  - **real LibreOffice exports:** a dissertation with table, figure, equation and citation passes the layout checks, is built from the snapshot (later edits absent), and has correct citation text; an over-long conference paper fails its 8-page limit.
- E2E `documents.spec.ts`: library → new dissertation → declaration and introduction with a picked citation → word count → comment → preview (APA citation, reference list, contents) → audit → PDF export rendered by the worker with checks shown → download → citation style changed to IEEE (specification version 2) → preview shows `[1, p. 1290]`.

**Totals:** 158 unit/integration tests and 8 E2E tests passing; typecheck clean; production build succeeds. A typical dissertation renders to PDF in under a second.

## Deployment notes

- The worker image now installs `libreoffice-writer-nogui`, `python3-uno` and metric-compatible fonts: Liberation for Times/Arial, Carlito and Caladea for Calibri/Cambria. Without the UNO module, conversion falls back to a plain LibreOffice conversion and reports the contents page as "will update when opened in Word".
- `DOCUMENT_CONCURRENCY` (default 2) limits simultaneous renders. Each render uses about 150–250 MB.
- Optional: `SOFFICE_PATH` and `LO_CONVERT_SCRIPT` override the defaults.

## Known limits

- Equations are rendered as text with common symbols, not as Word math objects.
- Footnotes, cross-references and lists of tables and figures are not yet supported.
- The preview shows structure, not exact pagination; pagination is checked on the PDF.
- Documents are edited one section at a time with conflict detection, not with real-time co-editing.
