import { type DbOrTx, researchProjects } from "@researchmate/database";
import { AppError } from "@researchmate/shared";
import { getOrgAccess, getProjectAccess } from "@researchmate/tenancy";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";

export const SEARCH_KINDS = {
  reference: "Reference",
  evidence: "Evidence",
  passage: "File text",
  file: "File",
  section: "Document section",
  task: "Task",
  comment: "Task comment",
  feedback: "Supervisor feedback",
  question: "Research question",
  objective: "Objective",
  hypothesis: "Hypothesis",
  risk: "Risk",
  event: "Calendar event",
} as const;
export type SearchKind = keyof typeof SEARCH_KINDS;

export interface SearchHit {
  kind: SearchKind;
  id: string;
  projectId: string;
  projectTitle: string;
  title: string;
  /** Plain text; matches are wrapped in « and ». Render as text, never as HTML. */
  snippet: string;
  link: string;
  rank: number;
}

const ids = (list: string[]) => sql.join(list.map((id) => sql`${id}::uuid`), sql`, `);

/**
 * Project-aware full-text search (§31) over references, evidence, extracted
 * file text, file names, document sections, tasks and their comments,
 * supervisor feedback, research questions/objectives/hypotheses, risks and
 * calendar events. Permissions are applied before the query: only projects
 * the user can read are searched, and file names/contents only where they
 * also hold project.files.read. PostgreSQL English text search with
 * websearch syntax ("quoted phrases", OR, -exclude).
 */
export async function searchProjects(db: DbOrTx, userId: string, scope: { projectId: string } | { organizationId: string }, query: string, limit = 50): Promise<{ hits: SearchHit[]; searchedProjects: number }> {
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return { hits: [], searchedProjects: 0 };

  // Resolve the projects (and file access) up front, so the query can't reach anything else.
  const readable: string[] = [];
  const withFiles: string[] = [];
  if ("projectId" in scope) {
    const a = await getProjectAccess(db, userId, scope.projectId);
    readable.push(scope.projectId);
    if (a.permissions.has("project.files.read")) withFiles.push(scope.projectId);
  } else {
    await getOrgAccess(db, userId, scope.organizationId).catch(() => {
      throw new AppError("NOT_FOUND", "Organization not found.");
    });
    const all = await db.select({ id: researchProjects.id }).from(researchProjects).where(and(eq(researchProjects.organizationId, scope.organizationId), isNull(researchProjects.archivedAt))).limit(500);
    for (const p of all) {
      try {
        const a = await getProjectAccess(db, userId, p.id);
        readable.push(p.id);
        if (a.permissions.has("project.files.read")) withFiles.push(p.id);
      } catch {
        /* not visible to this user */
      }
    }
  }
  if (!readable.length) return { hits: [], searchedProjects: 0 };

  const tsq = sql`websearch_to_tsquery('english', ${q})`;
  const R = ids(readable);
  const F = withFiles.length ? ids(withFiles) : null;
  const per = Math.min(limit, 50);
  const hl = (doc: SQL) => sql`ts_headline('english', ${doc}, ${tsq}, 'MaxFragments=2, MaxWords=28, MinWords=10, StartSel=«, StopSel=», FragmentDelimiter= … ')`;
  /** One searchable source: a document expression, a title, a link, and the FROM/WHERE part. */
  const part = (kind: SearchKind, doc: SQL, title: SQL, link: SQL, from: SQL, stored?: SQL) => {
    const vec = stored ?? sql`to_tsvector('english', ${doc})`;
    return sql`(select ${kind}::text as kind, src.id::text as id, src.project_id::text as project_id, (${title})::text as title, ${hl(doc)} as snippet, (${link})::text as link, ts_rank(${vec}, ${tsq}) as rank
      from ${from} and ${vec} @@ ${tsq} order by rank desc limit ${per})`;
  };
  const parts: SQL[] = [
    part("reference", sql`coalesce(src.title, '') || ' ' || coalesce(src.first_author, '') || ' ' || coalesce(src.csl->>'abstract', '')`, sql`src.title`, sql`'/app/projects/' || src.project_id || '/literature?q=' || src.citation_key`, sql`"references" src where src.project_id in (${R})`, sql`src.search`),
    part("evidence", sql`coalesce(src.claim, '') || ' ' || coalesce(src.passage, '') || ' ' || coalesce(src.notes, '')`, sql`left(coalesce(nullif(src.claim, ''), src.passage), 140)`, sql`'/app/projects/' || src.project_id || '/literature/evidence'`, sql`evidence_records src where src.project_id in (${R})`),
    part("section", sql`coalesce(s.title, '') || ' ' || coalesce(s.content, '')`, sql`d.title || ' — ' || s.title`, sql`'/app/projects/' || src.project_id || '/documents/' || d.id || '?section=' || s.id`, sql`document_sections s join documents d on d.id = s.document_id, lateral (select s.id, d.project_id) src where d.project_id in (${R})`),
    part("task", sql`coalesce(src.title, '') || ' ' || coalesce(src.description, '')`, sql`src.title`, sql`'/app/projects/' || src.project_id || '/tasks/' || src.id`, sql`research_tasks src where src.project_id in (${R})`),
    part("comment", sql`c.body`, sql`'Comment on: ' || t.title`, sql`'/app/projects/' || src.project_id || '/tasks/' || t.id`, sql`task_comments c join research_tasks t on t.id = c.task_id, lateral (select c.id, t.project_id) src where t.project_id in (${R})`),
    part("feedback", sql`coalesce(c.quote, '') || ' ' || coalesce(c.body, '')`, sql`'Feedback: ' || coalesce(c.section_title, 'document')`, sql`'/app/projects/' || src.project_id || '/reviews/' || rr.id`, sql`supervisor_feedback_comments c join supervisor_feedback fb on fb.id = c.feedback_id join review_requests rr on rr.id = fb.review_request_id, lateral (select c.id, rr.project_id) src where rr.project_id in (${R})`),
    part("question", sql`src.text`, sql`src.text`, sql`'/app/projects/' || src.project_id || '/research'`, sql`research_questions src where src.project_id in (${R})`),
    part("objective", sql`src.text`, sql`src.text`, sql`'/app/projects/' || src.project_id || '/research'`, sql`research_objectives src where src.project_id in (${R})`),
    part("hypothesis", sql`coalesce(src.null_hypothesis, '') || ' ' || coalesce(src.alternative_hypothesis, '')`, sql`left(src.alternative_hypothesis, 140)`, sql`'/app/projects/' || src.project_id || '/research'`, sql`research_hypotheses src where src.project_id in (${R})`),
    part("risk", sql`coalesce(src.title, '') || ' ' || coalesce(src.description, '') || ' ' || coalesce(src.mitigation, '')`, sql`src.title`, sql`'/app/projects/' || src.project_id || '/risks'`, sql`project_risks src where src.project_id in (${R})`),
    part("event", sql`coalesce(src.title, '') || ' ' || coalesce(src.location, '') || ' ' || coalesce(src.notes, '')`, sql`src.title`, sql`'/app/projects/' || src.project_id || '/calendar'`, sql`project_calendar_events src where src.project_id in (${R})`),
  ];
  if (F) {
    parts.push(
      part("file", sql`regexp_replace(src.original_name, '[._-]+', ' ', 'g')`, sql`src.original_name`, sql`'/api/files/' || src.id || '/download'`, sql`files src where src.project_id in (${F}) and src.deleted_at is null`),
      part("passage", sql`p.text`, sql`f.original_name || coalesce(' — p. ' || p.page, '')`, sql`'/app/projects/' || src.project_id || '/literature/passages?q=' || ${encodeURIComponent(q)}`, sql`file_passages p join files f on f.id = p.file_id and f.current_version = p.file_version and f.deleted_at is null, lateral (select p.id, f.project_id) src where f.project_id in (${F})`, sql`p.search`),
    );
  }
  const rows = (await db.execute(sql`
    select h.*, rp.title as project_title from (${sql.join(parts, sql` union all `)}) h
    join research_projects rp on rp.id = h.project_id::uuid
    order by h.rank desc, h.title limit ${Math.min(limit, 200)}`)) as unknown as { kind: SearchKind; id: string; project_id: string; project_title: string; title: string; snippet: string; link: string; rank: number }[];
  return {
    searchedProjects: readable.length,
    hits: rows.map((r) => ({ kind: r.kind, id: r.id, projectId: r.project_id, projectTitle: r.project_title, title: r.title || SEARCH_KINDS[r.kind], snippet: r.snippet, link: r.link, rank: Number(r.rank) })),
  };
}
