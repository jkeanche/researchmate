import {
  CITATION_STYLES,
  type Database,
  PROJECT_STATUSES,
  projectMembers,
  RESEARCH_TYPES,
  researchProjects,
} from "@researchmate/database";
import { checkProjectQuota, lockOrganization } from "@researchmate/entitlements";
import { AppError } from "@researchmate/shared";
import { getOrgAccess, getProjectAccess, recordAudit, requireOrgPermission, requireProjectPermission } from "@researchmate/tenancy";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { optionalDate, optionalInt, optionalText, parse } from "./util";
import { copyTemplateToProject, defaultTemplateKeyFor } from "./workflow";

export * from "./content";
export * from "./members";
export * from "./workflow";
export { parse } from "./util";

export { CITATION_STYLES, PROJECT_STATUSES, RESEARCH_TYPES };

export const RESEARCH_TYPE_LABELS: Record<(typeof RESEARCH_TYPES)[number], string> = {
  undergraduate_project: "Undergraduate project",
  masters_thesis: "Master's thesis / dissertation",
  phd_dissertation: "PhD dissertation",
  journal_article: "Journal article",
  conference_paper: "Conference paper",
  research_proposal: "Research proposal",
  scientific_paper: "Scientific paper",
  institutional_research: "Institutional research",
  business_research: "Business / market research",
  technical_report: "Technical report",
  independent_research: "Independent research",
  custom: "Custom",
};

export const CITATION_STYLE_LABELS: Record<(typeof CITATION_STYLES)[number], string> = {
  apa7: "APA 7",
  harvard: "Harvard",
  mla: "MLA",
  chicago: "Chicago",
  ieee: "IEEE",
  vancouver: "Vancouver",
  custom: "Custom",
};

export const STATUS_LABELS: Record<(typeof PROJECT_STATUSES)[number], string> = {
  draft: "Draft",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  archived: "Archived",
};

export const projectInputSchema = z
  .object({
    title: z.string().trim().min(3, "Title must be at least 3 characters").max(300),
    description: z.string().trim().max(5000).optional().default(""),
    researchType: z.enum(RESEARCH_TYPES),
    academicLevel: optionalText(100),
    discipline: optionalText(150),
    institution: optionalText(200),
    department: optionalText(200),
    methodology: optionalText(2000),
    citationStyle: z.enum(CITATION_STYLES).default("apa7"),
    targetWordCount: optionalInt(2_000_000),
    targetPageCount: optionalInt(10_000),
    startDate: optionalDate,
    expectedCompletionDate: optionalDate,
  })
  .refine((v) => !v.startDate || !v.expectedCompletionDate || v.expectedCompletionDate >= v.startDate, {
    message: "Expected completion must be on or after the start date",
    path: ["expectedCompletionDate"],
  });

export const projectUpdateSchema = projectInputSchema.innerType().partial().extend({
  status: z.enum(PROJECT_STATUSES).optional(),
  progressPercent: optionalInt(100),
  progressSource: z.enum(["manual", "tasks"]).optional(),
});

export type ProjectInput = z.input<typeof projectInputSchema> & {
  /** Workflow template to copy; undefined = the default for the research type; "" = none. */
  workflowTemplateKey?: string;
};

export class ProjectService {
  constructor(private readonly db: Database) {}

  async create(actorUserId: string, organizationId: string, input: ProjectInput) {
    const data = parse(projectInputSchema, input);
    await requireOrgPermission(this.db, actorUserId, organizationId, "projects.create");
    return this.db.transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await checkProjectQuota(tx, organizationId);
      const [project] = await tx
        .insert(researchProjects)
        .values({ ...data, organizationId, createdByUserId: actorUserId, status: "draft" })
        .returning();
      await tx.insert(projectMembers).values({ projectId: project!.id, userId: actorUserId, roleKey: "project_lead" });
      const templateKey = input.workflowTemplateKey === undefined ? await defaultTemplateKeyFor(tx, organizationId, data.researchType) : input.workflowTemplateKey || null;
      if (templateKey) await copyTemplateToProject(tx, project!.id, organizationId, templateKey);
      await recordAudit(tx, { organizationId, actorUserId, action: "project.created", targetType: "project", targetId: project!.id, metadata: { title: data.title } });
      return project!;
    });
  }

  async get(actorUserId: string, projectId: string) {
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    const [project] = await this.db.select().from(researchProjects).where(eq(researchProjects.id, projectId));
    return { project: project!, access };
  }

  async update(actorUserId: string, projectId: string, input: unknown) {
    const data = parse(projectUpdateSchema, input);
    const access = await requireProjectPermission(this.db, actorUserId, projectId, "project.update");
    const [current] = await this.db.select().from(researchProjects).where(eq(researchProjects.id, projectId));
    if (!current) throw new AppError("NOT_FOUND", "Project not found.");
    if (current.status === "archived" && data.status !== undefined && data.status !== "archived") {
      throw new AppError("VALIDATION", "Use restore to reactivate an archived project.");
    }
    if (current.status === "archived") throw new AppError("READ_ONLY", "This project is archived. Restore it before editing.");
    if (data.status === "archived") throw new AppError("VALIDATION", "Use archive to archive a project.");
    const start = data.startDate !== undefined ? data.startDate : current.startDate;
    const end = data.expectedCompletionDate !== undefined ? data.expectedCompletionDate : current.expectedCompletionDate;
    if (start && end && end < start) throw new AppError("VALIDATION", "Expected completion must be on or after the start date.");

    // Progress is derived from tasks unless the project uses manual progress.
    if ((data.progressSource ?? current.progressSource) === "tasks") delete (data as { progressPercent?: unknown }).progressPercent;
    const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    const [updated] = await this.db
      .update(researchProjects)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(researchProjects.id, projectId))
      .returning();
    await recordAudit(this.db, {
      organizationId: access.organizationId,
      actorUserId,
      action: "project.updated",
      targetType: "project",
      targetId: projectId,
      metadata: { fields: Object.keys(patch) },
    });
    return updated!;
  }

  async archive(actorUserId: string, projectId: string) {
    const access = await requireProjectPermission(this.db, actorUserId, projectId, "project.archive");
    await this.db
      .update(researchProjects)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(researchProjects.id, projectId), ne(researchProjects.status, "archived")));
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "project.archived", targetType: "project", targetId: projectId });
  }

  async restore(actorUserId: string, projectId: string) {
    const access = await requireProjectPermission(this.db, actorUserId, projectId, "project.archive");
    await this.db
      .update(researchProjects)
      .set({ status: "active", archivedAt: null, updatedAt: new Date() })
      .where(and(eq(researchProjects.id, projectId), eq(researchProjects.status, "archived")));
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "project.restored", targetType: "project", targetId: projectId });
  }

  /** Projects the user can see in an organization. */
  async list(actorUserId: string, organizationId: string) {
    const org = await getOrgAccess(this.db, actorUserId, organizationId);
    const columns = {
      id: researchProjects.id,
      title: researchProjects.title,
      researchType: researchProjects.researchType,
      status: researchProjects.status,
      progressPercent: researchProjects.progressPercent,
      expectedCompletionDate: researchProjects.expectedCompletionDate,
      updatedAt: researchProjects.updatedAt,
      citationStyle: researchProjects.citationStyle,
    };
    if (org.permissions.has("projects.read_all")) {
      return this.db.select(columns).from(researchProjects).where(eq(researchProjects.organizationId, organizationId)).orderBy(desc(researchProjects.updatedAt));
    }
    const memberProjectIds = this.db
      .select({ id: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, actorUserId));
    return this.db
      .select(columns)
      .from(researchProjects)
      .where(and(eq(researchProjects.organizationId, organizationId), inArray(researchProjects.id, memberProjectIds)))
      .orderBy(desc(researchProjects.updatedAt));
  }

  /** Upcoming deadlines across visible projects (dashboard). */
  async upcomingDeadlines(actorUserId: string, organizationId: string, days = 120) {
    const all = await this.list(actorUserId, organizationId);
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    return all
      .filter((p) => p.expectedCompletionDate && p.status !== "archived" && p.status !== "completed" && p.expectedCompletionDate <= horizon)
      .map((p) => ({ ...p, overdue: p.expectedCompletionDate! < today }))
      .sort((a, b) => a.expectedCompletionDate!.localeCompare(b.expectedCompletionDate!));
  }
}

export * from "./search";
