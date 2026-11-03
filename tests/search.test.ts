import { filePassages } from "@researchmate/database";
import { LiteratureService, ScholarlyClient } from "@researchmate/literature";
import { PlanningService } from "@researchmate/planning";
import { ProjectService, ResearchContentService, searchProjects } from "@researchmate/research";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, fileServices, setPlan, streamOf, testDb } from "./helpers";

afterAll(closeTestDb);
const db = () => testDb();

async function seed() {
  const owner = await createUser("Searcher");
  await setPlan(owner.orgId, "research_pro");
  const projects = new ProjectService(db());
  const p1 = await projects.create(owner.userId, owner.orgId, { title: "Mobile money and savings", researchType: "masters_thesis", workflowTemplateKey: "" });
  const p2 = await projects.create(owner.userId, owner.orgId, { title: "Rainfall and harvests", researchType: "masters_thesis", workflowTemplateKey: "" });
  const content = new ResearchContentService(db());
  await content.addQuestion(owner.userId, p1.id, { text: "Does mobile money adoption increase household savings?", kind: "main" });
  await new PlanningService(db()).createTask(owner.userId, p1.id, { title: "Interview M-Pesa agents", description: "Ask agents about savings behaviour in Kisumu", startDate: "2026-11-01", endDate: "2026-11-10" });
  await new PlanningService(db()).createTask(owner.userId, p2.id, { title: "Collect rainfall records", description: "County weather stations", startDate: "2026-11-01", endDate: "2026-11-10" });
  await new LiteratureService(db(), { scholarly: new ScholarlyClient() }).addManual(owner.userId, p1.id, { title: "The long-run poverty and gender impacts of mobile money", authors: "Suri, Tavneet; Jack, William", year: 2016 });
  const { files } = fileServices();
  const body = Buffer.from("Household savings rose by 22 percent after agents arrived.");
  const f = await files.upload({ actorUserId: owner.userId, organizationId: owner.orgId, projectId: p1.id, filename: "suri-notes.txt", declaredSize: body.length, body: streamOf(body) });
  await db().insert(filePassages).values({ fileId: f.id, fileVersion: 1, page: 3, text: body.toString() });
  return { owner, p1, p2 };
}

describe("project search", () => {
  it("finds tasks, questions, references and file text, ranked, with highlighted snippets", async () => {
    const { owner, p1 } = await seed();
    const { hits } = await searchProjects(db(), owner.userId, { projectId: p1.id }, "savings");
    const kinds = new Set(hits.map((h) => h.kind));
    for (const k of ["question", "task", "passage"]) expect(kinds).toContain(k);
    expect(hits.every((h) => h.projectId === p1.id)).toBe(true);
    const passage = hits.find((h) => h.kind === "passage")!;
    expect(passage.snippet).toContain("«savings»");
    expect(passage.title).toBe("suri-notes.txt — p. 3");
    expect(hits.find((h) => h.kind === "task")!.link).toMatch(new RegExp(`^/app/projects/${p1.id}/tasks/`));
    const ref = await searchProjects(db(), owner.userId, { projectId: p1.id }, '"mobile money" gender');
    expect(ref.hits.map((h) => h.kind)).toContain("reference");
    expect((await searchProjects(db(), owner.userId, { projectId: p1.id }, "savings -household")).hits.some((h) => h.kind === "question")).toBe(false);
  });

  it("searches across the organization's projects the user can read", async () => {
    const { owner, p1, p2 } = await seed();
    const r = await searchProjects(db(), owner.userId, { organizationId: owner.orgId }, "rainfall OR savings");
    expect(r.searchedProjects).toBeGreaterThanOrEqual(2);
    expect(new Set(r.hits.map((h) => h.projectId))).toEqual(new Set([p1.id, p2.id]));
    expect(r.hits.find((h) => h.projectId === p2.id)!.projectTitle).toBe("Rainfall and harvests");
  });

  it("never returns another tenant's records, and treats queries as data", async () => {
    const { p1 } = await seed();
    const outsider = await createUser("Outsider");
    await expect(searchProjects(db(), outsider.userId, { projectId: p1.id }, "savings")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const own = await searchProjects(db(), outsider.userId, { organizationId: outsider.orgId }, "savings");
    expect(own.hits).toHaveLength(0);
    await expect(searchProjects(db(), outsider.userId, { organizationId: (await seed()).owner.orgId }, "savings")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Query syntax errors and SQL metacharacters are harmless.
    const { owner, p1: p } = await seed();
    for (const q of ["'; drop table users; --", "((((", "a", "&&& | !!!"]) await expect(searchProjects(db(), owner.userId, { projectId: p.id }, q)).resolves.toBeTruthy();
  });
});
