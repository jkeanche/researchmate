import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import { researchProjects } from "./research";
import { organizations } from "./tenancy";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const day = (name: string) => date(name, { mode: "string" });
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const projectRef = () =>
  uuid("project_id")
    .notNull()
    .references(() => researchProjects.id, { onDelete: "cascade" });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });

// ---------------------------------------------------------------------------
// Research questions, objectives, hypotheses
// ---------------------------------------------------------------------------

export const QUESTION_KINDS = ["main", "specific"] as const;
export const OBJECTIVE_KINDS = ["general", "specific"] as const;

export const researchQuestions = pgTable(
  "research_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    kind: text("kind").notNull().default("specific"),
    text: text("text").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("research_questions_project_idx").on(t.projectId, t.sortOrder), check("research_questions_kind_check", sql`${t.kind} in (${inList(QUESTION_KINDS)})`)],
);

export const researchObjectives = pgTable(
  "research_objectives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    kind: text("kind").notNull().default("specific"),
    text: text("text").notNull(),
    /** The research question this objective answers (objective-to-question alignment). */
    questionId: uuid("question_id").references(() => researchQuestions.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("research_objectives_project_idx").on(t.projectId, t.sortOrder), check("research_objectives_kind_check", sql`${t.kind} in (${inList(OBJECTIVE_KINDS)})`)],
);

export const researchHypotheses = pgTable(
  "research_hypotheses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    questionId: uuid("question_id").references(() => researchQuestions.id, { onDelete: "set null" }),
    nullHypothesis: text("null_hypothesis").notNull(),
    alternativeHypothesis: text("alternative_hypothesis").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("research_hypotheses_project_idx").on(t.projectId, t.sortOrder)],
);

// ---------------------------------------------------------------------------
// Workflow templates and project stages
// ---------------------------------------------------------------------------

export const workflowTemplates = pgTable(
  "workflow_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** null = system template available to every organization. */
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    version: integer("version").notNull().default(1),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    defaultFor: jsonb("default_for").$type<string[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workflow_templates_key_version_idx").on(sql`coalesce(${t.organizationId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.key, t.version)],
);

export interface StageDependencySpec {
  key: string;
  type: "FS" | "SS" | "FF" | "SF";
  lagDays: number;
}

export const workflowStages = pgTable(
  "workflow_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull().default(""),
    expectedOutputs: text("expected_outputs").notNull().default(""),
    completionCriteria: text("completion_criteria").notNull().default(""),
    durationDays: integer("duration_days").notNull(),
    dependsOn: jsonb("depends_on").$type<StageDependencySpec[]>().notNull().default([]),
    approvalRequired: boolean("approval_required").notNull().default(false),
    optional: boolean("optional").notNull().default(false),
    milestoneName: text("milestone_name"),
    sortOrder: integer("sort_order").notNull(),
  },
  (t) => [unique("workflow_stages_template_key").on(t.templateId, t.key), check("workflow_stages_duration_check", sql`${t.durationDays} > 0`)],
);

export const STAGE_STATUSES = ["not_started", "in_progress", "awaiting_approval", "completed", "skipped"] as const;

/** A project's own copy of its workflow; editable without affecting the template. */
export const projectStages = pgTable(
  "project_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    templateStageId: uuid("template_stage_id").references(() => workflowStages.id, { onDelete: "set null" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull().default(""),
    requiredInputs: text("required_inputs").notNull().default(""),
    expectedOutputs: text("expected_outputs").notNull().default(""),
    completionCriteria: text("completion_criteria").notNull().default(""),
    nominalDurationDays: integer("nominal_duration_days").notNull().default(7),
    dependsOn: jsonb("depends_on").$type<StageDependencySpec[]>().notNull().default([]),
    milestoneName: text("milestone_name"),
    sortOrder: integer("sort_order").notNull(),
    /** Iteration number when a stage is repeated (1 = first pass). */
    iteration: integer("iteration").notNull().default(1),
    enabled: boolean("enabled").notNull().default(true),
    optional: boolean("optional").notNull().default(false),
    approvalRequired: boolean("approval_required").notNull().default(false),
    status: text("status").notNull().default("not_started"),
    responsibleUserId: userRef("responsible_user_id"),
    dueDate: day("due_date"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    awaitingApprovalSince: ts("awaiting_approval_since"),
    /** Accumulated time spent waiting for approval decisions (supervisor waiting time). */
    approvalWaitSeconds: integer("approval_wait_seconds").notNull().default(0),
    approvedByUserId: userRef("approved_by_user_id"),
    approvedAt: ts("approved_at"),
    approvalNote: text("approval_note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("project_stages_project_idx").on(t.projectId, t.sortOrder),
    check("project_stages_status_check", sql`${t.status} in (${inList(STAGE_STATUSES)})`),
    check("project_stages_wait_check", sql`${t.approvalWaitSeconds} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Tasks, milestones and dependencies
// ---------------------------------------------------------------------------

export const TASK_KINDS = ["task", "milestone"] as const;
export const TASK_STATUSES = ["todo", "in_progress", "blocked", "in_review", "done", "cancelled"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const DEPENDENCY_TYPES = ["FS", "SS", "FF", "SF"] as const;

/**
 * Tasks and milestones share a table so dependencies, the Gantt chart and the
 * critical path treat them uniformly. A milestone has start = end.
 * Dates are calendar dates; `end_date` is inclusive. A task with subtasks is a
 * summary: its dates and progress roll up from its children.
 */
export const researchTasks = pgTable(
  "research_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    stageId: uuid("stage_id").references(() => projectStages.id, { onDelete: "set null" }),
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => researchTasks.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("task"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("todo"),
    priority: text("priority").notNull().default("normal"),
    assigneeUserId: userRef("assignee_user_id"),
    startDate: day("start_date").notNull(),
    endDate: day("end_date").notNull(),
    actualStartDate: day("actual_start_date"),
    actualEndDate: day("actual_end_date"),
    progressPercent: smallint("progress_percent").notNull().default(0),
    estimateHours: numeric("estimate_hours", { precision: 8, scale: 2, mode: "number" }),
    /** An approved deadline: only users with project.plan.approve may move it, explicitly. */
    deadlineLocked: boolean("deadline_locked").notNull().default(false),
    requiresCompletionApproval: boolean("requires_completion_approval").notNull().default(false),
    completionApprovedByUserId: userRef("completion_approved_by_user_id"),
    completionApprovedAt: ts("completion_approved_at"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Optimistic concurrency: incremented on every update. */
    version: integer("version").notNull().default(1),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("research_tasks_project_idx").on(t.projectId, t.sortOrder),
    index("research_tasks_parent_idx").on(t.parentTaskId),
    index("research_tasks_assignee_idx").on(t.assigneeUserId),
    check("research_tasks_kind_check", sql`${t.kind} in (${inList(TASK_KINDS)})`),
    check("research_tasks_status_check", sql`${t.status} in (${inList(TASK_STATUSES)})`),
    check("research_tasks_priority_check", sql`${t.priority} in (${inList(TASK_PRIORITIES)})`),
    check("research_tasks_dates_check", sql`${t.endDate} >= ${t.startDate}`),
    check("research_tasks_milestone_check", sql`${t.kind} <> 'milestone' or ${t.endDate} = ${t.startDate}`),
    check("research_tasks_actual_dates_check", sql`${t.actualEndDate} is null or ${t.actualStartDate} is null or ${t.actualEndDate} >= ${t.actualStartDate}`),
    check("research_tasks_progress_check", sql`${t.progressPercent} between 0 and 100`),
    check("research_tasks_estimate_check", sql`${t.estimateHours} is null or ${t.estimateHours} >= 0`),
    check("research_tasks_not_own_parent", sql`${t.parentTaskId} is null or ${t.parentTaskId} <> ${t.id}`),
  ],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    predecessorId: uuid("predecessor_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    successorId: uuid("successor_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("FS"),
    lagDays: integer("lag_days").notNull().default(0),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("task_dependencies_pair").on(t.predecessorId, t.successorId),
    index("task_dependencies_project_idx").on(t.projectId),
    index("task_dependencies_successor_idx").on(t.successorId),
    check("task_dependencies_type_check", sql`${t.type} in (${inList(DEPENDENCY_TYPES)})`),
    check("task_dependencies_not_self", sql`${t.predecessorId} <> ${t.successorId}`),
    check("task_dependencies_lag_check", sql`${t.lagDays} between -365 and 365`),
  ],
);

export const taskChecklistItems = pgTable(
  "task_checklist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    done: boolean("done").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("task_checklist_items_task_idx").on(t.taskId, t.sortOrder)],
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    authorUserId: userRef("author_user_id"),
    body: text("body").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("task_comments_task_idx").on(t.taskId, t.createdAt)],
);

/** Additional people on a task, with an allocation used by the workload view. */
export const projectResourceAssignments = pgTable(
  "project_resource_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    allocationPercent: smallint("allocation_percent").notNull().default(100),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [unique("project_resource_assignments_task_user").on(t.taskId, t.userId), check("project_resource_assignments_alloc_check", sql`${t.allocationPercent} between 1 and 100`)],
);

export const TIME_CATEGORIES = ["research", "writing", "analysis", "data_collection", "revision", "meeting", "admin", "other"] as const;

export const researchTimeEntries = pgTable(
  "research_time_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    taskId: uuid("task_id").references(() => researchTasks.id, { onDelete: "set null" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    entryDate: day("entry_date").notNull(),
    minutes: integer("minutes").notNull(),
    category: text("category").notNull().default("research"),
    note: text("note").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("research_time_entries_project_idx").on(t.projectId, t.entryDate),
    check("research_time_entries_minutes_check", sql`${t.minutes} between 1 and 1440`),
    check("research_time_entries_category_check", sql`${t.category} in (${inList(TIME_CATEGORIES)})`),
  ],
);

// ---------------------------------------------------------------------------
// Baselines, revisions, proposals
// ---------------------------------------------------------------------------

/**
 * An approved snapshot of the schedule. Baselines and their items are
 * append-only: database triggers reject UPDATE and DELETE (except when the
 * whole project is deleted), so the original baseline can never be overwritten.
 */
export const projectScheduleBaselines = pgTable(
  "project_schedule_baselines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    number: integer("number").notNull(),
    name: text("name").notNull(),
    note: text("note").notNull().default(""),
    approvedByUserId: userRef("approved_by_user_id"),
    plannedFinish: day("planned_finish"),
    taskCount: integer("task_count").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [unique("project_schedule_baselines_number").on(t.projectId, t.number)],
);

export const projectScheduleBaselineItems = pgTable(
  "project_schedule_baseline_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    baselineId: uuid("baseline_id")
      .notNull()
      .references(() => projectScheduleBaselines.id, { onDelete: "cascade" }),
    /** Not a foreign key: the baseline must survive deletion of the task. */
    taskId: uuid("task_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    startDate: day("start_date").notNull(),
    endDate: day("end_date").notNull(),
    estimateHours: numeric("estimate_hours", { precision: 8, scale: 2, mode: "number" }),
  },
  (t) => [unique("project_schedule_baseline_items_task").on(t.baselineId, t.taskId)],
);

export const REVISION_SOURCES = ["manual", "gantt", "cascade", "rollup", "proposal", "locked_override"] as const;

/** Every change to a task's planned dates, with who made it and why. */
export const projectScheduleRevisions = pgTable(
  "project_schedule_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    changedByUserId: userRef("changed_by_user_id"),
    source: text("source").notNull(),
    oldStartDate: day("old_start_date"),
    oldEndDate: day("old_end_date"),
    newStartDate: day("new_start_date").notNull(),
    newEndDate: day("new_end_date").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("project_schedule_revisions_task_idx").on(t.taskId, t.createdAt), check("project_schedule_revisions_source_check", sql`${t.source} in (${inList(REVISION_SOURCES)})`)],
);

export const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "superseded"] as const;

export interface ProposedTask {
  ref: string;
  stageId: string | null;
  kind: "task" | "milestone";
  title: string;
  startDate: string;
  endDate: string;
}
export interface ProposedDependency {
  predecessorRef: string;
  successorRef: string;
  type: "FS" | "SS" | "FF" | "SF";
  lagDays: number;
}
export interface SchedulePayload {
  tasks: ProposedTask[];
  dependencies: ProposedDependency[];
  assumptions: string[];
}

/**
 * A proposed schedule awaiting a human decision. Nothing reaches the project
 * plan until a user with project.plan.approve approves it.
 */
export const scheduleProposals = pgTable(
  "schedule_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    /** template = deterministic generator; ai = suggested by an agent (later milestone). */
    source: text("source").notNull(),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<SchedulePayload>().notNull(),
    createdByUserId: userRef("created_by_user_id"),
    decidedByUserId: userRef("decided_by_user_id"),
    decidedAt: ts("decided_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("schedule_proposals_project_idx").on(t.projectId, t.createdAt),
    check("schedule_proposals_status_check", sql`${t.status} in (${inList(PROPOSAL_STATUSES)})`),
    check("schedule_proposals_source_check", sql`${t.source} in ('template', 'ai')`),
  ],
);

// ---------------------------------------------------------------------------
// Risks and calendar
// ---------------------------------------------------------------------------

export const RISK_CATEGORIES = ["schedule", "data_collection", "ethics", "financial", "technical", "personnel", "supervision", "other"] as const;
export const RISK_STATUSES = ["open", "mitigating", "occurred", "closed"] as const;

export const projectRisks = pgTable(
  "project_risks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default("other"),
    likelihood: smallint("likelihood").notNull(),
    impact: smallint("impact").notNull(),
    status: text("status").notNull().default("open"),
    ownerUserId: userRef("owner_user_id"),
    mitigation: text("mitigation").notNull().default(""),
    contingency: text("contingency").notNull().default(""),
    taskId: uuid("task_id").references(() => researchTasks.id, { onDelete: "set null" }),
    reviewDate: day("review_date"),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("project_risks_project_idx").on(t.projectId),
    check("project_risks_likelihood_check", sql`${t.likelihood} between 1 and 5`),
    check("project_risks_impact_check", sql`${t.impact} between 1 and 5`),
    check("project_risks_category_check", sql`${t.category} in (${inList(RISK_CATEGORIES)})`),
    check("project_risks_status_check", sql`${t.status} in (${inList(RISK_STATUSES)})`),
  ],
);

export const EVENT_KINDS = ["meeting", "supervisor_meeting", "deadline", "fieldwork", "conference", "other"] as const;

export const projectCalendarEvents = pgTable(
  "project_calendar_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("meeting"),
    startDate: day("start_date").notNull(),
    endDate: day("end_date").notNull(),
    /** Optional local time (HH:MM) for timed events. */
    startTime: text("start_time"),
    location: text("location").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("project_calendar_events_project_idx").on(t.projectId, t.startDate),
    check("project_calendar_events_kind_check", sql`${t.kind} in (${inList(EVENT_KINDS)})`),
    check("project_calendar_events_dates_check", sql`${t.endDate} >= ${t.startDate}`),
    check("project_calendar_events_time_check", sql`${t.startTime} is null or ${t.startTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  ],
);
