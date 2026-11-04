"use server";

import { getRedis, RedisRateLimiter } from "@researchmate/auth";
import { AppError } from "@researchmate/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type FormState, handle, str } from "../form";
import { supportService } from "../services";
import { getSession, requestContext, requireWorkspace } from "../session";

const limiter = () => new RedisRateLimiter(getRedis());

async function throttle(key: string, limit: number, windowSeconds: number) {
  const r = await limiter().hit(key, limit, windowSeconds);
  if (!r.allowed) throw new AppError("RATE_LIMITED", `Too many messages. Please try again in ${Math.ceil(r.retryAfterSeconds / 60)} minute(s).`);
}

/** Public contact form. */
export async function contactAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    // Bots fill in every field; people never see this one.
    if (str(form, "website")) return { success: "Thank you. We've received your message." };
    const session = await getSession();
    const { ipAddress } = await requestContext();
    await throttle(`contact:ip:${ipAddress ?? "unknown"}`, 5, 3600);
    await throttle(`contact:email:${str(form, "email").trim().toLowerCase()}`, 3, 3600);
    const { ticket } = await supportService().create({
      name: str(form, "name"),
      email: str(form, "email"),
      category: str(form, "category"),
      subject: str(form, "subject"),
      body: str(form, "body"),
      userId: session?.user.id ?? null,
    });
    return { success: `Thank you. Your reference is ${ticket.reference}. We've emailed you a link to follow your enquiry and we'll reply by email.` };
  });
}

/** Help → new enquiry, for signed-in users. */
export async function helpAction(_: FormState, form: FormData): Promise<FormState> {
  let target = "";
  const r = await handle(async () => {
    const { session, org } = await requireWorkspace();
    await throttle(`help:user:${session.user.id}`, 10, 3600);
    const { ticket } = await supportService().create({ category: str(form, "category"), subject: str(form, "subject"), body: str(form, "body"), userId: session.user.id, organizationId: org.organizationId });
    revalidatePath("/app/help");
    target = `/app/help/${ticket.id}?sent=1`;
  });
  if (target) redirect(target);
  return r;
}

/** A requester's reply: signed in (Help) or through a guest's private link. */
export async function supportReplyAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const ticketId = str(form, "ticketId");
    const token = str(form, "token");
    const { ipAddress } = await requestContext();
    await throttle(`support-reply:${ticketId}:${ipAddress ?? "unknown"}`, 20, 3600);
    if (token) {
      await supportService().requesterReply({ token }, ticketId, str(form, "body"));
      revalidatePath(`/support/${ticketId}`);
    } else {
      const session = await getSession();
      if (!session) throw new AppError("UNAUTHENTICATED", "Sign in to reply.");
      await supportService().requesterReply({ userId: session.user.id }, ticketId, str(form, "body"));
      revalidatePath(`/app/help/${ticketId}`);
    }
    return { success: "Sent. We'll reply by email." };
  });
}
