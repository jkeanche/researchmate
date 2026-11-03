# Milestone 2 report: storage, research management and project planning

Date: 2 November 2026

## Scope delivered

Blueprint phases 4 (completion), 5 and 6:

- **S3-compatible storage** alongside the local driver.
- **Research management:** research questions, objectives and hypotheses with an objective-to-question alignment check; configurable workflows copied from versioned templates, with stages that can be reordered, repeated, disabled, made optional or approval-gated; project membership with project roles.
- **Project planning:** tasks, subtasks and milestones; four dependency types with lag, cycle detection and automatic forward cascading; an interactive Gantt chart bound to the task records; critical path; immutable numbered baselines with variance; forecast completion; locked (approved) deadlines; schedule proposals generated from the workflow; task list, work breakdown, Kanban board and calendar; risk register with a 5×5 matrix; calendar events; time tracking with active, revision and approval-waiting time kept separate; weekly workload per person; full schedule history per task.

Not in this milestone, by design: optional finances (Phase 7) and anything AI.

## Architecture decisions

Full list in [architecture/decisions.md](../architecture/decisions.md#milestone-2-additions-storage-research-management-and-planning); new blueprint findings are items 13–21 in [spec-review.md](spec-review.md). The most important:

- The scheduling engine is a set of **pure functions** (`@researchmate/planning/engine`), tested without a database. The service wraps it in transactions that lock the project row.
- **Dependencies push later work forward, never pull it back.** An edit that breaks one of its own dependencies is refused with the earliest valid date.
- **Approved deadlines are locked:** only an approver can move them, explicitly and with a reason. A cascade that would move one fails as a whole. This is the mechanism for the blueprint's "AI must not silently change approved deadlines".
- **Baselines are append-only and the database enforces it**, using triggers.
- **Generated schedules are proposals.** They only add tasks, and only after an approver accepts.
- **The Gantt chart is built in-house** (SVG, about 500 lines). No maintained, permissively licensed library offered four dependency types, baselines and server-validated drag without a paid tier.

## Modules

| Package / app | Added |
|---|---|
| `@researchmate/storage` | `S3StorageDriver` (multipart streaming, byte cap, abort-on-error, key prefix, health probe); driver selected by `STORAGE_DRIVER` |
| `@researchmate/database` | `schema/planning.ts`, migration `0001_planning`, workflow template catalogue, planning permissions, `planning.tasks.max` |
| `@researchmate/research` | `ResearchContentService`, `ProjectMemberService`, `WorkflowService`, template copy on project creation, `progressSource` |
| `@researchmate/planning` (new) | Engine: dates, hierarchy and WBS, roll-up, dependency validation, cycle detection, reschedule/cascade, critical path, forecast, baseline variance, weighted progress, proposal generator, workload. `PlanningService`: tasks, dependencies, baselines, proposals, checklists, comments, resource assignments, risks, events, time |
| `apps/web` | Project layout and sub-navigation. Pages: overview (status dashboard), research, workflow, schedule (Gantt, proposal, baselines, variance, milestones, critical path), tasks (list / work breakdown / board), task detail, calendar, risks, time and workload, team. Gantt and board client components, planning server actions, print styles |
| `apps/worker` | `demo:seed` script (development only) |

## Database migration

`packages/database/migrations/0001_planning.sql`:

- New tables: `research_questions`, `research_objectives`, `research_hypotheses`, `workflow_templates`, `workflow_stages`, `project_stages`, `research_tasks`, `task_dependencies`, `task_checklist_items`, `task_comments`, `project_resource_assignments`, `research_time_entries`, `project_schedule_baselines`, `project_schedule_baseline_items`, `project_schedule_revisions`, `schedule_proposals`, `project_risks`, `project_calendar_events`.
- `research_projects` gains `progress_source`, `workflow_template_key` and `workflow_template_version`. Existing projects are set to manual progress so their values are kept.
- Constraints: end ≥ start; a milestone has a single date; progress is 0–100; no self-dependency and unique pairs; lag within ±365 days; likelihood and impact 1–5; event time `HH:MM`; time entries 1–1440 minutes; status, kind and category CHECKs.
- Triggers `rm_baseline_immutable` on both baseline tables.

Reference data synced by `pnpm db:migrate`: 3 new permissions, updated role grants and descriptions, `planning.tasks.max` (Free 20, others unlimited), 4 workflow templates.

## Environment variables

New: `S3_FORCE_PATH_STYLE` and `S3_KEY_PREFIX`. With `STORAGE_DRIVER=s3`, the existing `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are now read. Test-only: `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY_ID` and `TEST_S3_SECRET_ACCESS_KEY`.

## Tests executed and results

| Suite | Tests | Result |
|---|---|---|
| `tests/planning-engine.test.ts`: dates, all four dependency types, milestones, cascades, summary moves, locked deadlines, cycle detection through hierarchies, critical path (incl. SS/FF and summaries), forecast, variance, weighted progress, WBS, proposals for every seeded template | 29 | passed |
| `tests/planning.test.ts`: templates on project creation; stage reorder/repeat/disable; approval wait time; research alignment; Free-tier limits and gates; **6 concurrent task creations at the limit yield exactly 2**; dependency cycles; Gantt cascade with revisions; stale-version conflict; subtask roll-up; locked-deadline override by approver only; assistant/supervisor permissions; completion approval; derived progress; tenant isolation; archived read-only; immutable baselines (DB refuses update/delete); project deletion still cascades; proposals superseded and approver-only; risks, events and time; workload | 17 | passed |
| `tests/s3-storage.test.ts` (against moto's S3 server): round trip with prefix; 17 MB multipart; oversize aborts leave no object or open multipart upload; idempotent delete; key validation; FileService upload/quota/download/delete/purge on S3 | 7 | passed |
| Milestone 1 suites (auth, entitlements and storage, tenancy, unit) | 56 | passed |
| **Unit and integration total** | **109** | **passed** |
| E2E `lifecycle.spec.ts` (M1) | 3 | passed |
| E2E `planning.spec.ts`: register → upgrade → project → propose → approve 22 items → **drag a Gantt bar, successors cascade** → keyboard move → PNG export → baseline → history shows the Gantt move → dependency loop refused → board status change persists | 1 | passed |
| `pnpm typecheck` | 10 workspaces | clean |
| `pnpm build` (production) | — | succeeds |

Visual check: every project page was rendered in Chromium at 1360 px and 390 px wide. No console errors, and no horizontal page overflow on phones (the Gantt and wide tables scroll inside their own containers; the calendar switches to an agenda list).

## Known limitations

- **S3 tested against moto, not MinIO or AWS.** The S3 protocol paths used (PUT, multipart, HEAD, GET, DELETE) are standard, but the first deployment against a real provider should run the S3 suite with `TEST_S3_ENDPOINT`.
- **Docker images still not built here.** A Docker daemon now starts, but Docker Hub is blocked from this environment, so base images can't be pulled. The Dockerfiles already copy all workspace packages, including the new one.
- **Gantt PDF** uses the browser's print-to-PDF. There's no server-side PDF yet.
- **Calendar days only.** No weekends, holidays or institution calendars.
- **Recurring tasks and reminders** (§8.4) are not implemented. Reminders depend on the notification system.
- Dependencies are edited on the task page, not by drawing arrows on the chart.
- The workload view counts this project only. It doesn't sum a person's load across projects.
- A lead researcher may approve their own stages (needed for solo projects). A four-eyes rule belongs with supervisor collaboration (Phase 12).
- Email invitations, admin UI and email change (from M1's list) remain open.

## Commands

```bash
pnpm install
pnpm db:migrate                                   # applies 0001_planning and syncs templates
pnpm dev && pnpm dev:worker
pnpm --filter @researchmate/worker demo:seed      # demo thesis with a full plan (dev only)
pnpm test && pnpm typecheck
bash infrastructure/scripts/e2e-local.sh
```

## Next milestone (recommended)

Phase 7, **optional project finances**, as the blueprint orders: budget settings per project behind `finance.budget`, versioned budgets, categories, expenses with an approval workflow, funding sources, multi-currency with stored rates, task-linked cost estimates (the task model and Gantt are ready for this), a financial dashboard and XLSX/CSV/PDF reports. Small follow-ups to fold in: email invitations, cross-project workload, and recurring tasks and reminders once notifications exist.
