import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiService } from "@researchmate/ai";
import { aiRuns, evidenceRecords, files as filesTable } from "@researchmate/database";
import { LiteratureService, ScholarlyClient } from "@researchmate/literature";
import { ProjectService, ResearchContentService } from "@researchmate/research";
import { FileService, LocalStorageDriver } from "@researchmate/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, setPlan, testDb } from "./helpers";
import { type MockLlm, startMockLlm } from "./support/mock-llm";

let llm: MockLlm;
const ai = () => new AiService(testDb(), { enqueue: async () => {}, allowPrivateEndpoints: true });
beforeAll(async () => (llm = await startMockLlm()));
afterAll(async () => {
  await llm.close();
  await closeTestDb();
});

const TEXT = `Mobile money adoption increased household savings by 22 percent in the treatment villages.
Effects were concentrated among female-headed households, who saved more after adoption.
Attrition was 9 percent and did not differ between arms.`;

async function setup() {
  const u = await createUser("Reviewer");
  await setPlan(u.orgId, "research_pro");
  const project = await new ProjectService(testDb()).create(u.userId, u.orgId, { title: "Mobile money review", researchType: "custom", workflowTemplateKey: "" });
  await new ResearchContentService(testDb()).addQuestion(u.userId, project.id, { kind: "main", text: "Does mobile money increase household savings?" });
  await ai().addCredential(u.userId, u.orgId, { providerKey: "openai_compatible", label: "Local", apiKey: "sk-test-key-0000", defaultModel: "mock-model", baseUrl: llm.url });
  const driver = new LocalStorageDriver(mkdtempSync(join(tmpdir(), "rm-ail-")));
  const queued: string[] = [];
  const lit = new LiteratureService(testDb(), { scholarly: new ScholarlyClient(), driver, enqueueExtraction: async (id) => void queued.push(id) });
  const files = new FileService({ db: testDb(), driver, maxUploadBytes: 1e6, afterStore: (f) => lit.queueExtraction(f.id, f.version, f.mimeType, f.aiProcessingAllowed) });
  await lit.importText(u.userId, project.id, "bibtex", "@article{suri2016, title={The long-run impacts of mobile money}, author={Suri, Tavneet and Jack, William}, year={2016}, doi={10.1234/suri}}");
  const [ref] = await lit.list(u.userId, project.id);
  const buf = Buffer.from(TEXT);
  const f = await files.upload({ actorUserId: u.userId, organizationId: u.orgId, projectId: project.id, filename: "suri2016.txt", declaredSize: buf.length, body: [buf] as never });
  await lit.processExtraction(queued[0]!);
  await lit.attachFullText(u.userId, ref!.id, f.id);
  return { u, project, lit, ref, fileId: f.id };
}

describe("evidence extraction agent", () => {
  it("keeps only quotes found verbatim in the document; accepting records AI evidence", async () => {
    const { u, project, ref } = await setup();
    const run = await ai().startRun(u.userId, project.id, "evidence-extraction", { referenceId: ref!.id });
    llm.reply(
      JSON.stringify({
        evidence: [
          { quote: "Mobile money adoption increased household savings by 22 percent in the treatment villages.", claim: "Savings rose 22%", researchQuestionIndex: 0 },
          { quote: "female-headed  households, who saved more after adoption", claim: "Gendered effect", researchQuestionIndex: null },
          { quote: "Mobile money tripled consumption in every village studied.", claim: "Fabricated", researchQuestionIndex: 0 },
        ],
      }),
    );
    await ai().processRun(run.id);
    const sent = JSON.stringify(llm.requests.at(-1)!.body.messages);
    expect(sent).toContain("Attrition was 9 percent");
    const [done] = await testDb().select().from(aiRuns).where(eq(aiRuns.id, run.id));
    expect(done).toMatchObject({ status: "succeeded", output: { evidence: 2, discardedNotFoundInDocument: 1 } });

    const [r] = await ai().listRuns(u.userId, project.id);
    expect(r!.suggestions).toHaveLength(2);
    expect(r!.suggestions[0]!.payload).toMatchObject({ referenceId: ref!.id, page: null });
    await ai().decideSuggestion(u.userId, r!.suggestions[0]!.id, "accept");
    const ev = await testDb().select().from(evidenceRecords).where(eq(evidenceRecords.projectId, project.id));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ referenceId: ref!.id, extractionMethod: "ai", reviewStatus: "accepted", verificationStatus: "unverified" });
    expect(ev[0]!.researchQuestionId).not.toBeNull();
  });

  it("refuses without full text, and when AI processing is off for the file", async () => {
    const { u, project, ref, fileId, lit } = await setup();
    await lit.importText(u.userId, project.id, "bibtex", "@article{nofile, title={No file attached here}, author={Doe, J.}, year={2020}}");
    const other = (await lit.list(u.userId, project.id)).find((x) => x.citationKey !== ref!.citationKey)!;
    const r1 = await ai().startRun(u.userId, project.id, "evidence-extraction", { referenceId: other.id });
    await ai().processRun(r1.id);
    expect((await testDb().select().from(aiRuns).where(eq(aiRuns.id, r1.id)))[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/Attach the source's full text/) });

    await testDb().update(filesTable).set({ aiProcessingAllowed: false }).where(eq(filesTable.id, fileId));
    const before = llm.requests.length;
    const r2 = await ai().startRun(u.userId, project.id, "evidence-extraction", { referenceId: ref!.id });
    await ai().processRun(r2.id);
    expect((await testDb().select().from(aiRuns).where(eq(aiRuns.id, r2.id)))[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/AI processing is turned off/) });
    expect(llm.requests.length).toBe(before); // nothing sent to the provider
  });
});

describe("literature review agent", () => {
  it("drafts from the matrix and evidence; rejects drafts citing sources outside the library", async () => {
    const { u, project, lit, ref } = await setup();
    const r0 = await ai().startRun(u.userId, project.id, "literature-review");
    await ai().processRun(r0.id);
    expect((await testDb().select().from(aiRuns).where(eq(aiRuns.id, r0.id)))[0]!.error).toMatch(/literature matrix or record some evidence/);

    await lit.saveMatrixEntry(u.userId, ref!.id, { basis: "full_text", methodology: "RCT", population: "Kenyan households", findings: "Savings +22%", limitations: "Single country", researchGap: "Long-run effects elsewhere" });
    const good = await ai().startRun(u.userId, project.id, "literature-review", { focus: "savings" });
    llm.reply(JSON.stringify({ sections: [{ heading: "Savings effects", text: "Randomised evidence finds savings rose by 22 percent [@suri2016, p. 3]." }], gaps: ["Few studies outside Kenya"] }));
    await ai().processRun(good.id);
    const [g] = await testDb().select().from(aiRuns).where(eq(aiRuns.id, good.id));
    expect(g).toMatchObject({ status: "succeeded", output: { citedKeys: ["suri2016"], gaps: ["Few studies outside Kenya"] } });
    expect(String(g!.output!.draft)).toContain("## Savings effects");
    expect(JSON.stringify(llm.requests.at(-1)!.body.messages)).toContain("basis: full_text");

    const bad = await ai().startRun(u.userId, project.id, "literature-review");
    llm.reply(JSON.stringify({ sections: [{ heading: "Effects", text: "Several studies agree [@suri2016; @madeup2021] that savings rise." }], gaps: [] }));
    await ai().processRun(bad.id);
    const [b] = await testDb().select().from(aiRuns).where(eq(aiRuns.id, bad.id));
    expect(b).toMatchObject({ status: "failed", error: expect.stringMatching(/not in your library \(madeup2021\)/) });
  });
});
