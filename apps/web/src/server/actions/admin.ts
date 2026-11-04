"use server";

import type { PlanInput, SupportStatus } from "@researchmate/admin";
import { AppError } from "@researchmate/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type FormState, handle, str } from "../form";
import { adminService, authService, planAdminService, supportService } from "../services";
import { requestContext, requireSession } from "../session";

/** A date field (YYYY-MM-DD) as the end of that day in UTC; empty = no date. */
function dateOrNull(v: string): Date | null {
  if (!v.trim()) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new AppError("VALIDATION", "Enter a valid date.");
  const d = new Date(`${v.trim()}T23:59:59Z`);
  if (Number.isNaN(d.getTime())) throw new AppError("VALIDATION", "Enter a valid date.");
  return d;
}

function planInput(form: FormData): PlanInput {
  return {
    name: str(form, "name"),
    description: str(form, "description"),
    price: str(form, "price"),
    currency: str(form, "currency"),
    billingInterval: str(form, "billingInterval") === "year" ? "year" : "month",
    isPublic: form.get("isPublic") === "on",
    isActive: form.get("isActive") === "on",
    sortOrder: Math.round(Number(str(form, "sortOrder") || "0")),
  };
}

/**
 * All platform-administration forms post here with an `intent`. The services
 * re-check that the signed-in user is an active platform administrator.
 */
export async function adminAction(_: FormState, form: FormData): Promise<FormState> {
  let target = "";
  const r = await handle(async () => {
    const s = await requireSession();
    const me = s.user.id;
    const admin = adminService();
    const plansSvc = planAdminService();
    const id = str(form, "id");
    const reason = str(form, "reason");
    const done = (msg: string): FormState => {
      revalidatePath("/app/admin", "layout");
      return { success: msg };
    };
    switch (str(form, "intent")) {
      // ---- users
      case "user.disable": {
        const res = await admin.setUserStatus(me, id, "disabled", reason);
        return done(res.changed ? `Account disabled; ${res.revokedSessions} session(s) signed out.` : "The account was already disabled.");
      }
      case "user.enable":
        await admin.setUserStatus(me, id, "active", reason);
        return done("Account enabled. They can sign in again.");
      case "user.verify":
        await admin.verifyEmail(me, id);
        return done("Email address marked as verified.");
      case "user.grant_admin":
        await admin.setPlatformAdmin(me, id, true, reason);
        return done("They are now a platform administrator.");
      case "user.revoke_admin":
        await admin.setPlatformAdmin(me, id, false, reason);
        return done("Administrator role removed.");
      case "user.revoke_sessions": {
        const n = await admin.revokeSessions(me, id);
        return done(`${n} session(s) signed out.`);
      }
      case "user.reset_2fa":
        await admin.resetTwoFactor(me, id, reason);
        return done("Two-factor authentication turned off and all sessions signed out. They've been notified.");
      case "user.password_reset": {
        const email = await admin.recordPasswordResetSent(me, id);
        await authService().requestPasswordReset(email, await requestContext());
        return done(`A password reset link was emailed to ${email}.`);
      }

      // ---- organizations and subscriptions
      case "org.assign_plan":
        await admin.assignPlan(me, id, { planId: str(form, "planId"), periodEnd: dateOrNull(str(form, "periodEnd")), reason });
        return done("Plan assigned. The owner has been notified.");
      case "org.set_period_end":
        await admin.setPeriodEnd(me, id, dateOrNull(str(form, "periodEnd")), reason);
        return done("End date updated.");
      case "org.cancel":
        await admin.cancelSubscription(me, id, { immediately: str(form, "when") === "now", reason });
        return done(str(form, "when") === "now" ? "Plan ended; the organization is on the default plan." : "The plan will end at the close of its period.");
      case "org.override":
        await admin.setOverride(me, id, { featureKey: str(form, "featureKey"), value: str(form, "value"), reason, expiresAt: dateOrNull(str(form, "expiresAt")) });
        return done("Override saved. It applies immediately.");
      case "org.remove_override":
        await admin.removeOverride(me, id, str(form, "featureKey"));
        return done("Override removed; the plan's value applies again.");
      case "org.credit": {
        const usd = Number(str(form, "usd"));
        await admin.adjustCredit(me, id, { usd, reason });
        return done(usd > 0 ? "Credit added." : "Credit removed.");
      }
      case "org.restore":
        await admin.restoreOrganization(me, id);
        return done("Deletion cancelled; the organization is back.");

      // ---- plans and prices
      case "plan.create": {
        const p = await plansSvc.create(me, { ...planInput(form), key: str(form, "key"), copyFromPlanId: str(form, "copyFromPlanId") || undefined });
        revalidatePath("/app/admin", "layout");
        target = `/app/admin/plans/${p.id}`;
        return;
      }
      case "plan.update":
        await plansSvc.update(me, id, planInput(form));
        return done("Plan saved.");
      case "plan.default":
        await plansSvc.setDefault(me, id);
        return done("Default plan changed. New organizations start on it.");
      case "plan.entitlements": {
        const raw: Record<string, string> = {};
        for (const [k, v] of form.entries()) if (k.startsWith("ent:") && typeof v === "string") raw[k.slice(4)] = v;
        const n = await plansSvc.setEntitlements(me, id, raw);
        return done(n ? `${n} change(s) saved. They apply now to every organization on this plan.` : "Nothing changed.");
      }
      case "price.create":
        await plansSvc.createPricePoint(me, {
          kind: str(form, "kind") === "credits" ? "credits" : "plan",
          planId: str(form, "planId") || undefined,
          interval: str(form, "interval") === "year" ? "year" : "month",
          currency: str(form, "currency"),
          amount: str(form, "amount"),
          creditUsd: str(form, "creditUsd"),
          label: str(form, "label"),
        });
        return done("Price added. Customers can buy it now.");
      case "price.activate":
      case "price.deactivate":
        await plansSvc.setPricePointActive(me, id, str(form, "intent") === "price.activate");
        return done(str(form, "intent") === "price.activate" ? "Price switched on." : "Price switched off. Past payments keep it.");

      // ---- enquiries
      case "ticket.reply":
        await supportService().reply(me, id, str(form, "body"), { status: (str(form, "status") || "pending") as SupportStatus });
        return done("Reply sent.");
      case "ticket.note":
        await supportService().addNote(me, id, str(form, "body"));
        return done("Note added (only administrators see it).");
      case "ticket.update":
        await supportService().update(me, id, {
          status: str(form, "status") || undefined,
          priority: str(form, "priority") || undefined,
          category: str(form, "category") || undefined,
          assignedToUserId: form.has("assignedToUserId") ? str(form, "assignedToUserId") || null : undefined,
        });
        return done("Enquiry updated.");

      // ---- integrations
      case "apify.enable":
      case "apify.disable":
        await admin.setApifyActorEnabled(me, id, str(form, "intent") === "apify.enable");
        return done(str(form, "intent") === "apify.enable" ? "Actor enabled for organizations with Apify." : "Actor disabled.");
      default:
        throw new AppError("VALIDATION", "Unknown action.");
    }
  });
  if (target) redirect(target);
  return r;
}

