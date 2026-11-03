/**
 * Role and permission catalogue (seed data; the runtime reads the database).
 *
 * Organization roles govern organization-wide actions. Project roles govern
 * what a member may do inside a single project.
 *
 * Effective project permissions =
 *   (project-scoped permissions granted by the user's organization role)
 *   ∪ (permissions of the user's project role, if they are a project member).
 * So an org owner sees every project; a finance manager sees finances on every
 * project but cannot edit research.
 * Finance permissions are a separate domain so research access never implies
 * financial access.
 */

export const PERMISSIONS = {
  // Organization
  "org.settings.manage": { domain: "organization", description: "Edit organization settings" },
  "org.members.manage": { domain: "organization", description: "Invite, remove and change roles of members" },
  "org.billing.manage": { domain: "billing", description: "Manage subscription and billing" },
  "org.audit.read": { domain: "organization", description: "Read organization audit log" },
  "projects.create": { domain: "research", description: "Create research projects" },
  "projects.read_all": { domain: "research", description: "See every project in the organization" },
  "files.upload": { domain: "files", description: "Upload files to the organization library" },
  "files.read_all": { domain: "files", description: "See every file in the organization" },

  // Project
  "project.read": { domain: "research", description: "View the project" },
  "project.update": { domain: "research", description: "Edit project details" },
  "project.archive": { domain: "research", description: "Archive or restore the project" },
  "project.members.manage": { domain: "research", description: "Manage project members" },
  "project.files.read": { domain: "files", description: "View and download project files" },
  "project.files.write": { domain: "files", description: "Upload and version project files" },
  "project.files.delete": { domain: "files", description: "Delete project files" },
  "project.review": { domain: "research", description: "Review and comment as a supervisor" },
  "project.plan.manage": { domain: "planning", description: "Create and edit tasks, milestones, dependencies, stages, risks and events" },
  "project.plan.approve": { domain: "planning", description: "Approve schedules, baselines, stage gates and changes to approved deadlines" },
  "project.tasks.work": { domain: "planning", description: "Update progress, checklists and time on tasks assigned to them" },
  "finance.read": { domain: "finance", description: "View project budgets and expenses" },
  "finance.manage": { domain: "finance", description: "Create and edit budgets and expenses" },
  "finance.approve": { domain: "finance", description: "Approve expenses and budget versions" },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export interface RoleSeed {
  key: string;
  name: string;
  description: string;
  scope: "organization" | "project";
  rank: number;
  permissions: PermissionKey[];
}

const ALL_PROJECT: PermissionKey[] = [
  "project.read",
  "project.update",
  "project.archive",
  "project.members.manage",
  "project.files.read",
  "project.files.write",
  "project.files.delete",
  "project.review",
  "project.plan.manage",
  "project.plan.approve",
  "project.tasks.work",
  "finance.read",
  "finance.manage",
  "finance.approve",
];

export const ROLE_SEEDS: RoleSeed[] = [
  // Organization roles
  {
    key: "org_owner",
    name: "Organization Owner",
    description: "Full control including billing and ownership.",
    scope: "organization",
    rank: 100,
    permissions: [
      "org.settings.manage",
      "org.members.manage",
      "org.billing.manage",
      "org.audit.read",
      "projects.create",
      "projects.read_all",
      "files.upload",
      "files.read_all",
      ...ALL_PROJECT,
    ],
  },
  {
    key: "org_admin",
    name: "Organization Admin",
    description: "Manage members, settings and all projects. No billing.",
    scope: "organization",
    rank: 80,
    permissions: [
      "org.settings.manage",
      "org.members.manage",
      "org.audit.read",
      "projects.create",
      "projects.read_all",
      "files.upload",
      "files.read_all",
      ...ALL_PROJECT.filter((p) => !p.startsWith("finance.")),
    ],
  },
  {
    key: "org_researcher",
    name: "Researcher",
    description: "Create projects and work on assigned research.",
    scope: "organization",
    rank: 50,
    permissions: ["projects.create", "files.upload"],
  },
  {
    key: "org_finance_manager",
    name: "Finance Manager",
    description: "Organization-wide financial oversight; no research editing.",
    scope: "organization",
    rank: 40,
    permissions: ["projects.read_all", "project.read", "finance.read", "finance.manage", "finance.approve"],
  },
  {
    key: "org_member",
    name: "Member",
    description: "Access only to projects they are added to.",
    scope: "organization",
    rank: 20,
    permissions: [],
  },
  {
    key: "org_viewer",
    name: "Viewer",
    description: "Read-only access to projects they are added to.",
    scope: "organization",
    rank: 10,
    permissions: [],
  },

  // Project roles
  {
    key: "project_lead",
    name: "Lead Researcher",
    description: "Owns the project; approves schedules, baselines and deadline changes.",
    scope: "project",
    rank: 100,
    permissions: ALL_PROJECT,
  },
  {
    key: "project_researcher",
    name: "Researcher",
    description: "Edits research content, tasks and the plan.",
    scope: "project",
    rank: 60,
    permissions: ["project.read", "project.update", "project.files.read", "project.files.write", "project.plan.manage", "project.tasks.work"],
  },
  {
    key: "project_supervisor",
    name: "Supervisor",
    description: "Reviews, comments and approves stage gates; cannot edit the plan.",
    scope: "project",
    rank: 50,
    permissions: ["project.read", "project.files.read", "project.review"],
  },
  {
    key: "project_assistant",
    name: "Research Assistant",
    description: "Updates progress, checklists and time on tasks assigned to them.",
    scope: "project",
    rank: 40,
    permissions: ["project.read", "project.files.read", "project.files.write", "project.tasks.work"],
  },
  {
    key: "project_finance_manager",
    name: "Finance Manager",
    description: "Manages project finances only.",
    scope: "project",
    rank: 40,
    permissions: ["project.read", "finance.read", "finance.manage", "finance.approve"],
  },
  {
    key: "project_viewer",
    name: "Viewer",
    description: "Read-only.",
    scope: "project",
    rank: 10,
    permissions: ["project.read", "project.files.read"],
  },
];

/** System budget categories (blueprint §9.2). Organizations can add their own. */
export const BUDGET_CATEGORY_SEEDS: { key: string; name: string }[] = [
  ["personnel", "Research personnel"],
  ["research_assistants", "Research assistants"],
  ["fieldwork", "Fieldwork"],
  ["travel", "Travel and transport"],
  ["accommodation", "Accommodation"],
  ["subsistence", "Meals and subsistence"],
  ["data_collection", "Data collection"],
  ["survey_administration", "Survey administration"],
  ["printing", "Printing and photocopying"],
  ["stationery", "Stationery"],
  ["equipment", "Equipment"],
  ["software", "Software and subscriptions"],
  ["communication", "Internet and communication"],
  ["laboratory", "Laboratory costs"],
  ["materials", "Research materials"],
  ["data_processing", "Data processing"],
  ["statistical_analysis", "Statistical analysis"],
  ["transcription", "Transcription"],
  ["translation", "Translation"],
  ["publication_fees", "Publication fees"],
  ["conference_fees", "Conference fees"],
  ["training", "Training"],
  ["ethics", "Ethics approval and administration"],
  ["other", "Other expenses"],
].map(([key, name]) => ({ key: key!, name: name! }));
