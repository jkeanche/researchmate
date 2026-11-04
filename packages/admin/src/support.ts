import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import {
  type Database,
  type DbOrTx,
  organizations,
  SUPPORT_CATEGORIES,
  SUPPORT_PRIORITIES,
  SUPPORT_STATUSES,
  supportTicketMessages,
  supportTickets,
  userProfiles,
  users,
} from "@researchmate/database";
import { AppError, logger } from "@researchmate/shared";
import { notify, recordAudit } from "@researchmate/tenancy";
import { aliasedTable, and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { requirePlatformAdmin } from "./guard";
import { likePattern, pageOf } from "./values";

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const CATEGORY_LABELS: Record<SupportCategory, string> = {
  general: "General question",
  sales: "Plans and pricing",
  billing: "Billing and payments",
  technical: "Technical problem",
  account: "My account",
  feedback: "Feedback or suggestion",
};

/** Structurally the same as the auth package's Mailer. */
export interface SupportMailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export interface SupportDeps {
  db: Database;
  mailer: SupportMailer;
  appUrl: string;
  /** Signs guest links (APP_SECRET). */
  secret: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function clean(s: string, max: number) {
  return s.replace(/\r\n?/g, "\n").trim().slice(0, max);
}
/** For email subjects: one line, no control characters. */
function oneLine(s: string, max = 150) {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

/**
 * Enquiries: the public contact form, signed-in users' help requests, and the
 * administrators' inbox. Guests get a private link (signed, not stored) to
 * follow the conversation and reply; signed-in users see theirs under Help.
 */
export class SupportService {
  constructor(private readonly deps: SupportDeps) {}
  private get db() {
    return this.deps.db;
  }

  /** The guest link's token: an HMAC of the ticket id, so it never needs storing. */
  tokenFor(ticketId: string): string {
    return createHmac("sha256", this.deps.secret).update(`support-ticket:${ticketId}`).digest("base64url").slice(0, 32);
  }

  private guestLink(ticketId: string) {
    return `${this.deps.appUrl.replace(/\/$/, "")}/support/${ticketId}?t=${this.tokenFor(ticketId)}`;
  }

  private link(t: { id: string; userId: string | null }) {
    return t.userId ? `${this.deps.appUrl.replace(/\/$/, "")}/app/help/${t.id}` : this.guestLink(t.id);
  }

  private verifyToken(ticketId: string, token: string): boolean {
    const a = Buffer.from(this.tokenFor(ticketId));
    const b = Buffer.from(token ?? "");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async newReference(tx: DbOrTx): Promise<string> {
    for (let i = 0; i < 8; i++) {
      const ref = `RM-${Array.from({ length: 6 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join("")}`;
      const [exists] = await tx.select({ id: supportTickets.id }).from(supportTickets).where(eq(supportTickets.reference, ref));
      if (!exists) return ref;
    }
    throw new AppError("INTERNAL", "Couldn't allocate an enquiry reference.");
  }

  private async mail(to: string, subject: string, text: string) {
    try {
      await this.deps.mailer.send({ to, subject: oneLine(subject, 200), text });
    } catch (err) {
      // The enquiry is saved either way; a mail problem must not lose it.
      logger.error("support.mail_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async admins(db: DbOrTx) {
    const rows = await db.select({ id: users.id }).from(users).where(and(eq(users.isPlatformAdmin, true), eq(users.status, "active")));
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------ requester side

  /**
   * Creates an enquiry. With `userId` the requester's name and email come
   * from their account (they can't impersonate someone else's address).
   */
  async create(input: { name?: string; email?: string; category: string; subject: string; body: string; userId?: string | null; organizationId?: string | null }) {
    let name = clean(input.name ?? "", 120);
    let email = clean(input.email ?? "", 254).toLowerCase();
    let organizationId: string | null = null;
    if (input.userId) {
      const [u] = await this.db.select({ email: users.email, name: userProfiles.displayName }).from(users).leftJoin(userProfiles, eq(userProfiles.userId, users.id)).where(eq(users.id, input.userId));
      if (!u) throw new AppError("UNAUTHENTICATED", "Sign in again.");
      name = u.name ?? u.email;
      email = u.email;
      if (input.organizationId) {
        const [m] = await this.db.execute<{ ok: number }>(sql`select 1 as ok from organization_members where organization_id = ${input.organizationId} and user_id = ${input.userId}`);
        organizationId = m ? input.organizationId : null;
      }
    }
    const category = (SUPPORT_CATEGORIES as readonly string[]).includes(input.category) ? (input.category as SupportCategory) : "general";
    const subject = oneLine(input.subject, 150);
    const body = clean(input.body, 10_000);
    if (name.length < 2) throw new AppError("VALIDATION", "Tell us your name.");
    if (!EMAIL.test(email)) throw new AppError("VALIDATION", "Enter a valid email address so we can reply.");
    if (subject.length < 3) throw new AppError("VALIDATION", "Add a short subject.");
    if (body.length < 10) throw new AppError("VALIDATION", "Tell us a little more (at least 10 characters).");

    const ticket = await this.db.transaction(async (tx) => {
      const reference = await this.newReference(tx);
      const [t] = await tx
        .insert(supportTickets)
        .values({ reference, requesterName: name, requesterEmail: email, userId: input.userId ?? null, organizationId, category, subject, source: input.userId ? "in_app" : "contact_form" })
        .returning();
      await tx.insert(supportTicketMessages).values({ ticketId: t!.id, authorType: "requester", authorUserId: input.userId ?? null, authorName: name, body });
      await notify(tx, { userIds: await this.admins(tx), kind: "support.enquiry", title: `New enquiry ${reference}: ${subject}`, body: `${name} <${email}> · ${CATEGORY_LABELS[category]}\n\n${body.slice(0, 500)}`, link: `/app/admin/enquiries/${t!.id}` });
      return t!;
    });
    await this.mail(
      email,
      `We received your enquiry [${ticket.reference}]`,
      `Hello ${name},\n\nThank you for contacting ResearchMate. We've received your enquiry “${subject}” (reference ${ticket.reference}) and will reply by email.\n\nYou can follow it and add details here:\n${this.link(ticket)}\n\n${input.userId ? "" : "Keep this link private: anyone with it can read the conversation.\n\n"}— The ResearchMate team`,
    );
    return { ticket, link: this.link(ticket) };
  }

  /** A guest's view through their private link. Internal notes are never included. */
  async forGuest(ticketId: string, token: string) {
    if (!/^[0-9a-f-]{36}$/.test(ticketId) || !this.verifyToken(ticketId, token)) throw new AppError("NOT_FOUND", "This link isn't valid.");
    return this.requesterView(ticketId);
  }

  async listForUser(userId: string) {
    return this.db
      .select({ id: supportTickets.id, reference: supportTickets.reference, subject: supportTickets.subject, status: supportTickets.status, category: supportTickets.category, lastMessageAt: supportTickets.lastMessageAt, createdAt: supportTickets.createdAt })
      .from(supportTickets)
      .where(eq(supportTickets.userId, userId))
      .orderBy(desc(supportTickets.lastMessageAt))
      .limit(100);
  }

  async forUser(userId: string, ticketId: string) {
    const [t] = await this.db.select({ id: supportTickets.id }).from(supportTickets).where(and(eq(supportTickets.id, ticketId), eq(supportTickets.userId, userId)));
    if (!t) throw new AppError("NOT_FOUND", "No such enquiry.");
    return this.requesterView(ticketId);
  }

  private async requesterView(ticketId: string) {
    const [ticket] = await this.db.select().from(supportTickets).where(eq(supportTickets.id, ticketId));
    if (!ticket) throw new AppError("NOT_FOUND", "No such enquiry.");
    const messages = await this.db
      .select({ id: supportTicketMessages.id, authorType: supportTicketMessages.authorType, authorName: supportTicketMessages.authorName, body: supportTicketMessages.body, createdAt: supportTicketMessages.createdAt })
      .from(supportTicketMessages)
      .where(and(eq(supportTicketMessages.ticketId, ticketId), ne(supportTicketMessages.authorType, "note")))
      .orderBy(asc(supportTicketMessages.createdAt));
    return { ticket: { id: ticket.id, reference: ticket.reference, subject: ticket.subject, status: ticket.status, category: ticket.category, createdAt: ticket.createdAt, requesterName: ticket.requesterName }, messages };
  }

  /** The requester adds to their enquiry (by private link, or signed in). Re-opens a resolved one. */
  async requesterReply(who: { userId: string } | { token: string }, ticketId: string, bodyInput: string) {
    const body = clean(bodyInput, 10_000);
    if (body.length < 2) throw new AppError("VALIDATION", "Write a message.");
    if ("token" in who) {
      if (!/^[0-9a-f-]{36}$/.test(ticketId) || !this.verifyToken(ticketId, who.token)) throw new AppError("NOT_FOUND", "This link isn't valid.");
    }
    await this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(supportTickets).where(eq(supportTickets.id, ticketId)).for("update");
      if (!t || ("userId" in who && t.userId !== who.userId)) throw new AppError("NOT_FOUND", "No such enquiry.");
      if (t.status === "closed") throw new AppError("VALIDATION", "This enquiry is closed. Please send a new one.");
      await tx.insert(supportTicketMessages).values({ ticketId, authorType: "requester", authorUserId: "userId" in who ? who.userId : null, authorName: t.requesterName, body });
      await tx.update(supportTickets).set({ status: "open", lastMessageAt: new Date(), updatedAt: new Date(), closedAt: null }).where(eq(supportTickets.id, ticketId));
      await notify(tx, { userIds: t.assignedToUserId ? [t.assignedToUserId] : await this.admins(tx), kind: "support.enquiry", title: `Reply on ${t.reference}: ${t.subject}`, body: `${t.requesterName}: ${body.slice(0, 500)}`, link: `/app/admin/enquiries/${t.id}` });
    });
  }

  // ---------------------------------------------------------------- admin side

  async counts(actorUserId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const [r] = await this.db
      .select({
        open: sql<number>`count(*) filter (where ${supportTickets.status} = 'open')::int`,
        mine: sql<number>`count(*) filter (where ${supportTickets.status} = 'open' and ${supportTickets.assignedToUserId} = ${actorUserId})::int`,
        unassigned: sql<number>`count(*) filter (where ${supportTickets.status} = 'open' and ${supportTickets.assignedToUserId} is null)::int`,
      })
      .from(supportTickets);
    return r!;
  }

  async list(actorUserId: string, opts: { status?: SupportStatus | "active" | "all"; category?: string; assigned?: "me" | "unassigned"; q?: string; page?: number } = {}) {
    await requirePlatformAdmin(this.db, actorUserId);
    const { limit, offset, page } = pageOf(opts.page);
    const where: (SQL | undefined)[] = [];
    const st = opts.status ?? "active";
    if (st === "active") where.push(inArray(supportTickets.status, ["open", "pending"]));
    else if (st !== "all") where.push(eq(supportTickets.status, st));
    if (opts.category && (SUPPORT_CATEGORIES as readonly string[]).includes(opts.category)) where.push(eq(supportTickets.category, opts.category));
    if (opts.assigned === "me") where.push(eq(supportTickets.assignedToUserId, actorUserId));
    if (opts.assigned === "unassigned") where.push(isNull(supportTickets.assignedToUserId));
    if (opts.q?.trim()) {
      const q = opts.q.trim();
      where.push(or(ilike(supportTickets.subject, likePattern(q)), ilike(supportTickets.requesterEmail, likePattern(q)), ilike(supportTickets.requesterName, likePattern(q)), eq(supportTickets.reference, q.toUpperCase())));
    }
    const cond = and(...where);
    const assignee = aliasedTable(users, "assignee");
    const rows = await this.db
      .select({ t: supportTickets, assignee: assignee.email, messages: sql<number>`(select count(*)::int from support_ticket_messages m where m.ticket_id = ${supportTickets.id} and m.author_type <> 'note')` })
      .from(supportTickets)
      .leftJoin(assignee, eq(assignee.id, supportTickets.assignedToUserId))
      .where(cond)
      .orderBy(sql`case ${supportTickets.status} when 'open' then 0 when 'pending' then 1 else 2 end`, sql`case ${supportTickets.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`, desc(supportTickets.lastMessageAt))
      .limit(limit)
      .offset(offset);
    const [{ n }] = (await this.db.select({ n: count() }).from(supportTickets).where(cond)) as [{ n: number }];
    return { rows, total: Number(n), page };
  }

  async get(actorUserId: string, ticketId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const [t] = await this.db.select().from(supportTickets).where(eq(supportTickets.id, ticketId));
    if (!t) throw new AppError("NOT_FOUND", "No such enquiry.");
    const messages = await this.db.select().from(supportTicketMessages).where(eq(supportTicketMessages.ticketId, ticketId)).orderBy(asc(supportTicketMessages.createdAt));
    const [account] = await this.db.select({ id: users.id, email: users.email, status: users.status, createdAt: users.createdAt }).from(users).where(t.userId ? eq(users.id, t.userId) : eq(users.email, t.requesterEmail));
    const [org] = t.organizationId ? await this.db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, t.organizationId)) : [];
    const earlier = await this.db
      .select({ id: supportTickets.id, reference: supportTickets.reference, subject: supportTickets.subject, status: supportTickets.status, createdAt: supportTickets.createdAt })
      .from(supportTickets)
      .where(and(eq(supportTickets.requesterEmail, t.requesterEmail), ne(supportTickets.id, t.id)))
      .orderBy(desc(supportTickets.createdAt))
      .limit(10);
    return { ticket: t, messages, account: account ?? null, organization: org ?? null, earlier };
  }

  /** Replies to the requester by email (and in the app for signed-in requesters). */
  async reply(actorUserId: string, ticketId: string, bodyInput: string, opts: { status?: SupportStatus } = {}) {
    const admin = await requirePlatformAdmin(this.db, actorUserId);
    const body = clean(bodyInput, 10_000);
    if (body.length < 2) throw new AppError("VALIDATION", "Write a reply.");
    const status = opts.status && (SUPPORT_STATUSES as readonly string[]).includes(opts.status) ? opts.status : "pending";
    const [profile] = await this.db.select({ name: userProfiles.displayName }).from(userProfiles).where(eq(userProfiles.userId, admin.id));
    const authorName = `${profile?.name ?? "ResearchMate"} (ResearchMate support)`;
    const t = await this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(supportTickets).where(eq(supportTickets.id, ticketId)).for("update");
      if (!t) throw new AppError("NOT_FOUND", "No such enquiry.");
      await tx.insert(supportTicketMessages).values({ ticketId, authorType: "staff", authorUserId: admin.id, authorName, body });
      const now = new Date();
      await tx
        .update(supportTickets)
        .set({ status, lastMessageAt: now, updatedAt: now, closedAt: status === "resolved" || status === "closed" ? now : null, assignedToUserId: t.assignedToUserId ?? admin.id })
        .where(eq(supportTickets.id, ticketId));
      await recordAudit(tx, { actorUserId: admin.id, action: "admin.support.replied", targetType: "support_ticket", targetId: ticketId, metadata: { reference: t.reference, status } });
      if (t.userId) await notify(tx, { userIds: [t.userId], kind: "support.reply", title: `Reply to your enquiry ${t.reference}`, body: body.slice(0, 1000), link: `/app/help/${t.id}`, dedupeKey: undefined });
      return t;
    });
    // Signed-in requesters are emailed through their notification (support.reply);
    // guests have no account, so they're emailed directly.
    if (!t.userId) {
      await this.mail(
        t.requesterEmail,
        `Re: ${t.subject} [${t.reference}]`,
        `Hello ${t.requesterName},\n\n${body}\n\n— ${authorName}\n\nTo reply, open your enquiry here (replies to this email aren't read):\n${this.guestLink(t.id)}`,
      );
    }
  }

  /** Internal note, visible to administrators only. */
  async addNote(actorUserId: string, ticketId: string, bodyInput: string) {
    const admin = await requirePlatformAdmin(this.db, actorUserId);
    const body = clean(bodyInput, 10_000);
    if (body.length < 2) throw new AppError("VALIDATION", "Write a note.");
    const [t] = await this.db.select({ id: supportTickets.id }).from(supportTickets).where(eq(supportTickets.id, ticketId));
    if (!t) throw new AppError("NOT_FOUND", "No such enquiry.");
    const [profile] = await this.db.select({ name: userProfiles.displayName }).from(userProfiles).where(eq(userProfiles.userId, admin.id));
    await this.db.insert(supportTicketMessages).values({ ticketId, authorType: "note", authorUserId: admin.id, authorName: profile?.name ?? admin.email, body });
    await this.db.update(supportTickets).set({ updatedAt: new Date() }).where(eq(supportTickets.id, ticketId));
  }

  async update(actorUserId: string, ticketId: string, input: { status?: string; priority?: string; category?: string; assignedToUserId?: string | null }) {
    await requirePlatformAdmin(this.db, actorUserId);
    const set: Partial<typeof supportTickets.$inferInsert> = { updatedAt: new Date() };
    if (input.status !== undefined) {
      if (!(SUPPORT_STATUSES as readonly string[]).includes(input.status)) throw new AppError("VALIDATION", "Unknown status.");
      set.status = input.status;
      set.closedAt = input.status === "resolved" || input.status === "closed" ? new Date() : null;
    }
    if (input.priority !== undefined) {
      if (!(SUPPORT_PRIORITIES as readonly string[]).includes(input.priority)) throw new AppError("VALIDATION", "Unknown priority.");
      set.priority = input.priority;
    }
    if (input.category !== undefined) {
      if (!(SUPPORT_CATEGORIES as readonly string[]).includes(input.category)) throw new AppError("VALIDATION", "Unknown category.");
      set.category = input.category;
    }
    if (input.assignedToUserId !== undefined) {
      if (input.assignedToUserId) {
        const [a] = await this.db.select({ id: users.id }).from(users).where(and(eq(users.id, input.assignedToUserId), eq(users.isPlatformAdmin, true), eq(users.status, "active")));
        if (!a) throw new AppError("VALIDATION", "Enquiries can only be assigned to platform administrators.");
      }
      set.assignedToUserId = input.assignedToUserId;
    }
    const [t] = await this.db.update(supportTickets).set(set).where(eq(supportTickets.id, ticketId)).returning();
    if (!t) throw new AppError("NOT_FOUND", "No such enquiry.");
    await recordAudit(this.db, { actorUserId, action: "admin.support.updated", targetType: "support_ticket", targetId: ticketId, metadata: { reference: t.reference, ...input } });
    if (input.assignedToUserId && input.assignedToUserId !== actorUserId)
      await notify(this.db, { userIds: [input.assignedToUserId], kind: "support.enquiry", title: `Enquiry ${t.reference} was assigned to you`, body: t.subject, link: `/app/admin/enquiries/${t.id}` });
  }
}
