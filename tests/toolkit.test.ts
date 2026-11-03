import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyses } from "@researchmate/database";
import { ProjectService } from "@researchmate/research";
import { FileService, LocalStorageDriver } from "@researchmate/storage";
import { buildCodebookXlsx, buildDeck, buildStatusReport, buildSurveyDocx, correlation, quantile, ToolkitService } from "@researchmate/toolkit";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, setPlan, testDb } from "./helpers";

afterAll(closeTestDb);

// Reference values below were computed with SciPy 1.x / NumPy (see docs/implementation/milestone-10.md).
const X = [2.1, 3.4, 1.9, 5.6, 4.4, 3.3, 6.1, 2.8, 4.9, 5.2, 3.7, 4.1, 2.5, 5.9, 3.0, 4.6];
const Y = [3.0, 4.1, 2.2, 6.9, 5.1, 3.9, 7.4, 3.1, 5.8, 6.0, 4.6, 4.4, 2.9, 7.1, 3.8, 5.5];
const G = X.map((_, i) => (i % 2 === 0 ? "urban" : "rural"));
const C = X.map((_, i) => ["A", "B", "C", "A"][i % 4]!);

function csv() {
  const lines = ["﻿id,x,y,setting,cluster,note"];
  X.forEach((x, i) => lines.push(`${i + 1},${x},${Y[i]},${G[i]},${C[i]},${i === 3 ? "=HYPERLINK(\"http://x\")" : "ok"}`));
  lines.push("17,NA,,urban,A,missing values");
  return Buffer.from(lines.join("\n"));
}

async function setup(plan = "research_pro") {
  const u = await createUser("Analyst");
  await setPlan(u.orgId, plan);
  const project = await new ProjectService(testDb()).create(u.userId, u.orgId, { title: "Savings study", researchType: "masters_thesis", workflowTemplateKey: "" });
  const driver = new LocalStorageDriver(mkdtempSync(join(tmpdir(), "rm-tk-")));
  const files = new FileService({ db: testDb(), driver, maxUploadBytes: 10e6 });
  const tk = new ToolkitService(testDb(), { driver });
  const upload = async (filename: string, body: Buffer) => files.upload({ actorUserId: u.userId, organizationId: u.orgId, projectId: project.id, filename, declaredSize: body.length, body: [body] as never });
  return { u, project, files, tk, upload };
}

describe("statistics (unit)", () => {
  it("quantile uses the type-7 definition", () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 10);
  });
  it("spearman matches SciPy", () => {
    const r = correlation(X, Y, "spearman");
    expect(r.r!).toBeCloseTo(0.9941176470588234, 6);
    expect(r.p!).toBeCloseTo(6.433997488446935e-15, 20);
  });
});

describe("toolkit service", () => {
  it("imports a CSV, infers types, treats NA as missing and runs analyses matching SciPy", async () => {
    const { u, project, tk, upload } = await setup();
    const f = await upload("survey.csv", csv());
    const ds = await tk.importDataset(u.userId, project.id, { fileId: f.id });
    expect(ds.rowCount).toBe(17);
    const types = Object.fromEntries(ds.columns.map((c) => [c.name, c.type]));
    expect(types).toMatchObject({ id: "numeric", x: "numeric", y: "numeric", setting: "categorical", cluster: "categorical" });
    expect(ds.columns.find((c) => c.name === "x")!.missing).toBe(1);

    const desc = await tk.analyse(u.userId, ds.id, "descriptives", { variables: ["x"] });
    const dx = (desc.result.variables as Record<string, number>[])[0]!;
    expect(dx.n).toBe(16);
    expect(dx.mean).toBeCloseTo(3.96875, 5);
    expect(dx.sd).toBeCloseTo(1.3415010249716546, 5);
    expect(dx.median).toBeCloseTo(3.9, 5);
    expect(dx.q1).toBeCloseTo(2.95, 5);
    expect(dx.q3).toBeCloseTo(4.975, 5);
    expect(desc.method).toMatch(/standard deviation/i);

    const corr = await tk.analyse(u.userId, ds.id, "correlation", { x: "x", y: "y", method: "pearson" });
    expect(corr.result.r as number).toBeCloseTo(0.9899199929319993, 5);
    expect(corr.result.p as number).toBeCloseTo(2.7608851666849323e-13, 18);
    expect(corr.result.n).toBe(16);

    const tt = await tk.analyse(u.userId, ds.id, "ttest", { outcome: "y", group: "setting" });
    expect(Math.abs(tt.result.t as number)).toBeCloseTo(0.9663935139022525, 5);
    expect(tt.result.p as number).toBeCloseTo(0.3506552265848671, 6);

    const an = await tk.analyse(u.userId, ds.id, "anova", { outcome: "y", group: "cluster" });
    expect(an.result.F as number).toBeCloseTo(0.2753433949465829, 5);
    expect(an.result.p as number).toBeCloseTo(0.7636305483955702, 6);

    const reg = await tk.analyse(u.userId, ds.id, "regression", { outcome: "y", predictors: ["x"] });
    const coefs = reg.result.coefficients as { name: string; estimate: number; se: number }[];
    expect(coefs[0]!.estimate).toBeCloseTo(0.05064249, 5);
    expect(coefs[0]!.se).toBeCloseTo(0.1885654, 5);
    expect(coefs[1]!.estimate).toBeCloseTo(1.18094047, 5);
    expect(coefs[1]!.se).toBeCloseTo(0.04515565, 5);
    expect(reg.result.r2 as number).toBeCloseTo(0.9799415924064895, 5);

    // The 17th row has no x/y and a missing cluster count; crosstab uses rows with both values.
    const ct = await tk.analyse(u.userId, ds.id, "crosstab", { row: "setting", column: "cluster" });
    expect(ct.result.n).toBe(17);
    const ct16 = await tk.analyse(u.userId, ds.id, "frequencies", { variable: "cluster" });
    expect((ct16.result.rows as { value: string; count: number }[]).find((r) => r.value === "A")!.count).toBe(9);

    const listed = await tk.listAnalyses(u.userId, ds.id);
    expect(listed.length).toBe(7);

    // CSV export neutralises spreadsheet formulas.
    const out = await tk.datasetCsv(u.userId, ds.id);
    expect(out).toContain("'=HYPERLINK");
    expect(out.split(/\r?\n/)[0]).toBe("id,x,y,setting,cluster,note");
  });

  it("chi-square matches SciPy on a 16-row crosstab", async () => {
    const { u, project, tk, upload } = await setup();
    const body = Buffer.from(["g,c", ...G.map((g, i) => `${g},${C[i]}`)].join("\n"));
    const ds = await tk.importDataset(u.userId, project.id, { fileId: (await upload("ct.csv", body)).id });
    const ct = await tk.analyse(u.userId, ds.id, "crosstab", { row: "g", column: "c" });
    expect(ct.result.chi2 as number).toBeCloseTo(8, 6);
    expect(ct.result.df).toBe(2);
    expect(ct.result.p as number).toBeCloseTo(0.018315638888734182, 6);
  });

  it("imports XLSX, records cleaning steps and validates variable choices", async () => {
    const { u, project, tk, upload } = await setup();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Responses");
    ws.addRow(["age", "income", "age"]);
    ws.addRow([34, 1200, 1]);
    ws.addRow([41, -99, 2]);
    ws.addRow([29, 980, 3]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const ds = await tk.importDataset(u.userId, project.id, { fileId: (await upload("data.xlsx", buf)).id });
    expect(ds.sheet).toBe("Responses");
    expect(ds.columns.map((c) => c.name)).toEqual(["age", "income", "age_2"]);
    await tk.updateColumn(u.userId, ds.id, "income", { label: "Monthly income (KES)", missingCodes: ["-99"] });
    const after = await tk.dataset(u.userId, ds.id);
    expect(after.columns[1]).toMatchObject({ label: "Monthly income (KES)", missing: 1 });
    expect(after.steps[0]).toMatchObject({ step: "set_missing", variable: "income", codes: ["-99"] });
    // Re-sending the unchanged type (as the edit form does) adds no step.
    await tk.updateColumn(u.userId, ds.id, "income", { type: "numeric" });
    expect((await tk.dataset(u.userId, ds.id)).steps).toHaveLength(1);
    const d = await tk.analyse(u.userId, ds.id, "descriptives", { variables: ["income"] });
    expect((d.result.variables as { n: number; mean: number }[])[0]).toMatchObject({ n: 2, mean: 1090 });
    await expect(tk.analyse(u.userId, ds.id, "descriptives", { variables: ["nope"] })).rejects.toThrow(/not found/);
    await expect(tk.analyse(u.userId, ds.id, "bogus", {})).rejects.toThrow(/Unknown analysis/);
    await expect(tk.analyse(u.userId, ds.id, "ttest", { outcome: "age", group: "income" })).rejects.toThrow(/two (groups|values)/i);
  });

  it("rejects non-tabular files and files from other projects", async () => {
    const { u, project, tk, upload, files } = await setup();
    const txt = await upload("notes.txt", Buffer.from("hello"));
    await expect(tk.importDataset(u.userId, project.id, { fileId: txt.id })).rejects.toThrow(/CSV or XLSX/);
    const other = await new ProjectService(testDb()).create(u.userId, u.orgId, { title: "Other", researchType: "masters_thesis", workflowTemplateKey: "" });
    const f = await files.upload({ actorUserId: u.userId, organizationId: u.orgId, projectId: other.id, filename: "a.csv", declaredSize: 7, body: [Buffer.from("a,b\n1,2")] as never });
    await expect(tk.importDataset(u.userId, project.id, { fileId: f.id })).rejects.toThrow(/this project/);
  });

  it("gates by plan: free has no toolkit, starter has basic tools only", async () => {
    const free = await setup("free");
    const f = await free.upload("a.csv", Buffer.from("a,b\n1,2\n3,4\n5,7"));
    await expect(free.tk.importDataset(free.u.userId, free.project.id, { fileId: f.id })).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    await expect(free.tk.createDiagram(free.u.userId, free.project.id, "conceptual")).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });

    const s = await setup("starter");
    const ds = await s.tk.importDataset(s.u.userId, s.project.id, { fileId: (await s.upload("a.csv", Buffer.from("a,b\n1,2\n3,4\n5,7"))).id });
    await s.tk.analyse(s.u.userId, ds.id, "descriptives", { variables: ["a", "b"] });
    await expect(s.tk.analyse(s.u.userId, ds.id, "correlation", { x: "a", y: "b" })).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    await expect(s.tk.analyse(s.u.userId, ds.id, "regression", { outcome: "b", predictors: ["a"] })).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    expect((await s.tk.access(s.u.userId, s.project.id, "read")).tier).toBe("basic");
  });

  it("keeps datasets inside the tenant", async () => {
    const { u, project, tk, upload } = await setup();
    const ds = await tk.importDataset(u.userId, project.id, { fileId: (await upload("a.csv", Buffer.from("a\n1\n2"))).id });
    const outsider = await createUser("Outsider");
    await setPlan(outsider.orgId, "research_pro");
    await expect(tk.dataset(outsider.userId, ds.id)).rejects.toThrow();
    await expect(tk.analyse(outsider.userId, ds.id, "missing", {})).rejects.toThrow();
    await expect(tk.listDatasets(outsider.userId, project.id)).rejects.toThrow();
    expect(await testDb().select().from(analyses).where(undefined as never).then((r) => r.filter((a) => a.datasetId === ds.id).length)).toBe(0);
  });

  it("diagrams: templates, optimistic revisions and locked security settings", async () => {
    const { u, project, tk } = await setup();
    const d = await tk.createDiagram(u.userId, project.id, "methodology");
    expect(d.source).toMatch(/^flowchart TD/);
    const saved = await tk.saveDiagram(u.userId, d.id, { title: "Study design", source: "flowchart LR\n  A --> B", revision: 1 });
    expect(saved.revision).toBe(2);
    await expect(tk.saveDiagram(u.userId, d.id, { title: "x", source: "flowchart LR\n  A --> C", revision: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(tk.saveDiagram(u.userId, d.id, { title: "x", source: "%%{init: {'securityLevel': 'loose'}}%%\nflowchart LR\n A-->B", revision: 2 })).rejects.toThrow(/security/);
    await expect(tk.createDiagram(u.userId, project.id, "nonsense")).rejects.toThrow(/diagram type/);
    expect((await tk.listDiagrams(u.userId, project.id)).length).toBe(1);
    await tk.deleteDiagram(u.userId, d.id);
    expect((await tk.listDiagrams(u.userId, project.id)).length).toBe(0);
  });

  it("questionnaires: validation, codebook and exports", async () => {
    const { u, project, tk } = await setup();
    const s = await tk.createSurvey(u.userId, project.id, "Household savings survey");
    await expect(tk.saveSurvey(u.userId, s.id, { questions: [{ id: "q1", type: "single", text: "Gender?", required: true, options: ["Only one"] }], revision: 1 })).rejects.toThrow(/two options/);
    await expect(tk.saveSurvey(u.userId, s.id, { questions: [{ id: "1bad", type: "open", text: "Why?", required: false }], revision: 1 })).rejects.toThrow(/Question 1/);
    const qs = [
      { id: "gender", type: "single", text: "What is your gender?", required: true, options: ["Female", "Male", "Prefer not to say"], section: "About you" },
      { id: "services", type: "multiple", text: "Which services do you use?", required: false, options: ["M-Pesa", "Bank account", "SACCO"] },
      { id: "trust", type: "likert", text: "I trust mobile money providers.", required: true, scale: { points: 5, low: "Strongly disagree", high: "Strongly agree" } },
      { id: "income", type: "number", text: "Monthly income (KES)", required: false },
      { id: "why", type: "open", text: "=cmd|' /C calc'!A0", required: false },
    ];
    await expect(tk.saveSurvey(u.userId, s.id, { questions: [qs[0], { ...qs[1], id: "gender" }], revision: 1 })).rejects.toThrow(/Two questions/);
    const saved = await tk.saveSurvey(u.userId, s.id, { questions: qs, revision: 1 });
    expect(saved.revision).toBe(2);
    await expect(tk.saveSurvey(u.userId, s.id, { questions: qs, revision: 1 })).rejects.toMatchObject({ code: "CONFLICT" });

    const cb = tk.codebook(saved);
    expect(cb.map((r) => r.variable)).toEqual(["gender", "services_1", "services_2", "services_3", "trust", "income", "why"]);
    expect(cb[0]!.codes).toBe("1 = Female; 2 = Male; 3 = Prefer not to say");

    const xlsx = await buildCodebookXlsx(saved, cb);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as never);
    expect(wb.getWorksheet("Codebook")!.getRow(8).getCell(2).value).toBe("'=cmd|' /C calc'!A0");
    expect((wb.getWorksheet("Data entry")!.getRow(1).values as unknown[]).slice(1)).toEqual(["respondent_id", ...cb.map((r) => r.variable)]);

    const docx = await buildSurveyDocx(saved);
    const text = (await mammoth.extractRawText({ buffer: docx })).value;
    expect(text).toContain("Household savings survey");
    expect(text).toContain("About you");
    expect(text).toContain("1. What is your gender?");
    expect(text).toContain("Strongly agree");
    expect(text).toContain("I agree to take part");
  });

  it("builds decks and a status report from recorded project data only", async () => {
    const { u, project, tk } = await setup();
    const data = await tk.projectData(u.userId, project.id);
    for (const kind of ["proposal", "progress", "defense"] as const) {
      const pptx = await buildDeck(data, kind);
      expect(pptx.subarray(0, 2).toString()).toBe("PK");
      expect(pptx.includes(Buffer.from("ppt/slides/slide3.xml"))).toBe(true);
    }
    const report = await buildStatusReport(data);
    const text = (await mammoth.extractRawText({ buffer: report })).value;
    expect(text).toContain("Savings study");
    expect(text).toMatch(/Overall progress is \d+%/);
    expect(text).toContain("No open risks recorded.");
  });
});

describe("sample-size calculators", () => {
  it("Cochran's formula with and without finite population correction", async () => {
    const { sampleSizeProportion } = await import("@researchmate/toolkit");
    const a = sampleSizeProportion({ confidence: 0.95, margin: 0.05, p: 0.5 });
    expect(a.n0).toBeCloseTo(384.1459, 3);
    expect(a.n).toBe(385);
    expect(sampleSizeProportion({ confidence: 0.95, margin: 0.05, p: 0.5, population: 1000 }).n).toBe(278);
    expect(() => sampleSizeProportion({ confidence: 0.95, margin: 0, p: 0.5 })).toThrow(/Margin/);
  });
  it("two-means sample size (z approximation)", async () => {
    const { sampleSizeTwoMeans } = await import("@researchmate/toolkit");
    const r = sampleSizeTwoMeans({ alpha: 0.05, power: 0.8, sd: 1, difference: 0.5 });
    expect(r.zAlpha).toBeCloseTo(1.959964, 5);
    expect(r.zBeta).toBeCloseTo(0.841621, 5);
    expect(r.nPerGroup).toBe(63);
    expect(r.total).toBe(126);
  });
});
