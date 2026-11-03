import { type Database, type DbOrTx, NOTIFICATION_KINDS, type NotificationKind, notificationPreferences, notifications, organizationMembers, organizations, type PermissionKey, projectMembers, researchProjects, researchTasks, users } from "@researchmate/database";
import { getProjectAccess } from "./permissions";
import { logger } from "@researchmate/shared";
import { and, asc, between, desc, eq, gte, inArray, isNull, lt, ne, notInArray, sql } from "drizzle-orm";

export interface NotifyInput {
  userIds: (string | null | undefined)[];
  kind: NotificationKind;
  title: string;
  body?: string;
  /** In-app path starting with /app/. */
  link?: string;
  organizationId?: string | null;
  projectId?: string | null;
  /** Suppresses repeats per recipient (e.g. `task.overdue:<taskId>:<date>`). */
  dedupeKey?: string;
}

/** Effective channel settings for each user (catalogue defaults overridden by preferences). */
export async function channelsFor(db: DbOrTx, userIds: string[], kind: NotificationKind) {
  const def = NOTIFICATION_KINDS[kind];
  const rows = userIds.length ? await db.select().from(notificationPreferences).where(and(inArray(notificationPreferences.userId, userIds), eq(notificationPreferences.kind, kind))) : [];
  const pref = new Map(rows.map((r) => [r.userId, r]));
  return new Map(
    userIds.map((u) => {
      const p = pref.get(u);
      const locked = "locked" in def && def.locked;
      return [u, { inApp: p?.inApp ?? def.inApp, email: locked ? true : (p?.email ?? def.email) }];
    }),
  );
}

/**
 * Records a notification for each recipient according to their preferences.
 * Email is delivered later by the worker (rows with email_status 'pending').
 * Runs in a savepoint and never throws, so a notification problem can't undo
 * or fail the action that triggered it.
 */
export async function notify(db: DbOrTx, input: NotifyInput): Promise<number> {
  const ids = [...new Set(input.userIds.filter((u): u is string => !!u))];
  if (!ids.length) return 0;
  if (input.link && !input.link.startsWith("/app/")) throw new Error("Notification links must be in-app paths.");
  try {
    const channels = await channelsFor(db, ids, input.kind);
    const values = ids
      .map((userId) => ({ userId, ch: channels.get(userId)! }))
      .filter(({ ch }) => ch.inApp || ch.email)
      .map(({ userId, ch }) => ({
        userId,
        organizationId: input.organizationId ?? null,
        projectId: input.projectId ?? null,
        kind: input.kind,
        title: input.title.slice(0, 300),
        body: (input.body ?? "").slice(0, 4000),
        link: input.link ?? null,
        dedupeKey: input.dedupeKey ?? null,
        inApp: ch.inApp,
        emailStatus: ch.email ? "pending" : "none",
      }));
    if (!values.length) return 0;
    const inserted = await db.transaction(async (t) => t.insert(notifications).values(values).onConflictDoNothing().returning({ id: notifications.id }));
    return inserted.length;
  } catch (err) {
    logger.error("notify.failed", { kind: input.kind, error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

export async function listNotifications(db: DbOrTx, userId: string, opts: { limit?: number; unreadOnly?: boolean } = {}) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.inApp, true), opts.unreadOnly ? isNull(notifications.readAt) : undefined))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));
}

export async function unreadCount(db: DbOrTx, userId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.inApp, true), isNull(notifications.readAt)));
  return r?.n ?? 0;
}

/** Marks one (or, without an id, all) of the user's notifications as read. Scoped to the user. */
export async function markRead(db: DbOrTx, userId: string, notificationId?: string) {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), notificationId ? eq(notifications.id, notificationId) : undefined));
}

export async function getPreferences(db: DbOrTx, userId: string) {
  const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  const pref = new Map(rows.map((r) => [r.kind, r]));
  return (Object.keys(NOTIFICATION_KINDS) as NotificationKind[]).map((kind) => {
    const def = NOTIFICATION_KINDS[kind];
    const locked = "locked" in def && def.locked;
    const p = pref.get(kind);
    return { kind, group: def.group, label: def.label, locked, inApp: p?.inApp ?? def.inApp, email: locked ? true : (p?.email ?? def.email) };
  });
}

export async function setPreferences(db: DbOrTx, userId: string, prefs: { kind: string; inApp: boolean; email: boolean }[]) {
  const valid = prefs.filter((p): p is { kind: NotificationKind; inApp: boolean; email: boolean } => p.kind in NOTIFICATION_KINDS);
  if (!valid.length) return;
  await db
    .insert(notificationPreferences)
    .values(valid.map((p) => ({ userId, kind: p.kind, inApp: p.inApp, email: "locked" in NOTIFICATION_KINDS[p.kind] ? true : p.email })))
    .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.kind], set: { inApp: sql`excluded.in_app`, email: sql`excluded.email` } });
}

/** Users who can act on a project with the given permission (project members and organization roles). */
export async function projectRecipients(db: DbOrTx, projectId: string, permission: PermissionKey, exclude: (string | null | undefined)[] = []): Promise<string[]> {
  const [p] = await db.select({ org: researchProjects.organizationId }).from(researchProjects).where(eq(researchProjects.id, projectId));
  if (!p) return [];
  const [pm, om] = await Promise.all([
    db.select({ u: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, projectId)),
    db.select({ u: organizationMembers.userId }).from(organizationMembers).where(eq(organizationMembers.organizationId, p.org)),
  ]);
  const skip = new Set(exclude.filter(Boolean));
  const out: string[] = [];
  for (const u of new Set([...pm, ...om].map((r) => r.u))) {
    if (skip.has(u)) continue;
    try {
      if ((await getProjectAccess(db, u, projectId)).permissions.has(permission)) out.push(u);
    } catch {
      /* no access */
    }
  }
  return out;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * Scheduled deadline notices (§30): tasks due within two days, tasks overdue
 * (looking back two weeks, so a first run doesn't flood), and milestones due
 * within a week. Deduplicated per task and due date, so hourly runs are safe.
 * Dates are calendar dates compared in UTC.
 */
export async function scanDeadlines(db: Database, now = new Date()) {
  const today = isoDay(now);
  const open = and(notInArray(researchTasks.status, ["done", "cancelled"]), ne(researchProjects.status, "archived"), isNull(organizations.deletedAt));
  // A fresh builder per query: Drizzle builders are mutable, so sharing one would let the last .where() win.
  const base = () => db
    .select({ t: researchTasks, title: researchProjects.title, owner: researchProjects.createdByUserId, org: researchProjects.organizationId })
    .from(researchTasks)
    .innerJoin(researchProjects, eq(researchProjects.id, researchTasks.projectId))
    .innerJoin(organizations, eq(organizations.id, researchProjects.organizationId));
  const [due, overdue, milestones] = await Promise.all([
    base().where(and(open, ne(researchTasks.kind, "milestone"), between(researchTasks.endDate, today, isoDay(addDays(now, 2))))).orderBy(asc(researchTasks.endDate)).limit(2000),
    base().where(and(open, ne(researchTasks.kind, "milestone"), lt(researchTasks.endDate, today), gte(researchTasks.endDate, isoDay(addDays(now, -14))))).limit(2000),
    base().where(and(open, eq(researchTasks.kind, "milestone"), between(researchTasks.endDate, today, isoDay(addDays(now, 7))))).limit(500),
  ]);
  let sent = 0;
  for (const r of due)
    sent += await notify(db, { userIds: [r.t.assigneeUserId ?? r.owner], kind: "task.due_soon", title: `Due ${r.t.endDate === today ? "today" : `on ${r.t.endDate}`}: ${r.t.title}`, body: `“${r.t.title}” in “${r.title}” is due ${r.t.endDate === today ? "today" : `on ${r.t.endDate}`} (${r.t.progressPercent}% done).`, link: `/app/projects/${r.t.projectId}/tasks/${r.t.id}`, organizationId: r.org, projectId: r.t.projectId, dedupeKey: `task.due_soon:${r.t.id}:${r.t.endDate}` });
  for (const r of overdue)
    sent += await notify(db, { userIds: [r.t.assigneeUserId ?? r.owner], kind: "task.overdue", title: `Overdue: ${r.t.title}`, body: `“${r.t.title}” in “${r.title}” was due on ${r.t.endDate}. Update its dates or mark it done.`, link: `/app/projects/${r.t.projectId}/tasks/${r.t.id}`, organizationId: r.org, projectId: r.t.projectId, dedupeKey: `task.overdue:${r.t.id}:${r.t.endDate}` });
  for (const r of milestones)
    sent += await notify(db, { userIds: await projectRecipients(db, r.t.projectId, "project.read"), kind: "milestone.due_soon", title: `Milestone on ${r.t.endDate}: ${r.t.title}`, body: `The milestone “${r.t.title}” in “${r.title}” is due on ${r.t.endDate}.`, link: `/app/projects/${r.t.projectId}/schedule`, organizationId: r.org, projectId: r.t.projectId, dedupeKey: `milestone:${r.t.id}:${r.t.endDate}` });
  return { dueSoon: due.length, overdue: overdue.length, milestones: milestones.length, created: sent };
}

/**
 * Hands pending notification emails to `send` (the email queue), at most
 * `limit` per run. Rows are claimed with SKIP LOCKED so parallel workers never
 * double-send. Users who are disabled or unverified are skipped.
 */
export async function deliverNotificationEmails(db: Database, send: (m: { to: string; subject: string; text: string }) => Promise<void>, appUrl: string, limit = 200) {
  const base = appUrl.replace(/\/$/, "");
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ n: notifications, email: users.email, verified: users.emailVerifiedAt, status: users.status })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(eq(notifications.emailStatus, "pending"))
      .orderBy(asc(notifications.createdAt))
      .limit(limit)
      .for("update", { of: notifications, skipLocked: true });
    let sent = 0;
    for (const r of rows) {
      if (!r.verified || r.status !== "active") {
        await tx.update(notifications).set({ emailStatus: "skipped" }).where(eq(notifications.id, r.n.id));
        continue;
      }
      try {
        await send({
          to: r.email,
          subject: r.n.title,
          text: `${r.n.body}${r.n.link ? `\n\n${base}${r.n.link}` : ""}\n\n—\nYou're receiving this because of your ResearchMate notification settings: ${base}/app/settings/notifications`,
        });
        await tx.update(notifications).set({ emailStatus: "sent", emailedAt: new Date() }).where(eq(notifications.id, r.n.id));
        sent++;
      } catch {
        await tx.update(notifications).set({ emailStatus: "failed" }).where(eq(notifications.id, r.n.id));
      }
    }
    return { claimed: rows.length, sent };
  });
}
