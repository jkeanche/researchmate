"use server";

import { AppError } from "@researchmate/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type FormState, handle, str } from "../form";
import { paymentService } from "../services";
import { requireSession, requireWorkspace } from "../session";

const usd = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 1_000_000));

export async function billingAction(_: FormState, form: FormData): Promise<FormState> {
  let target = "";
  const r = await handle(async () => {
    const { session, org } = await requireWorkspace();
    const svc = paymentService();
    switch (str(form, "intent")) {
      case "buy": {
        const { redirectUrl } = await svc.checkout(session.user.id, org.organizationId, { pricePointId: str(form, "pricePointId"), provider: str(form, "provider") });
        target = redirectUrl;
        return;
      }
      case "limits": {
        const monthly = usd(str(form, "monthlyCap"));
        const perRun = usd(str(form, "perRunCap"));
        if ([monthly, perRun].some((v) => v !== null && (!Number.isFinite(v) || v < 0))) throw new AppError("VALIDATION", "Enter amounts in US dollars.");
        await svc.ledger.setLimits(session.user.id, org.organizationId, { monthlyCapMicros: monthly, perRunCapMicros: perRun });
        revalidatePath("/app/settings/billing");
        return { success: "Spending limits saved." };
      }
      case "cancel":
      case "resume":
        await svc.setCancelAtPeriodEnd(session.user.id, org.organizationId, str(form, "intent") === "cancel");
        revalidatePath("/app/settings/billing");
        return { success: str(form, "intent") === "cancel" ? "Your plan will end at the close of the paid period. Nothing is deleted." : "Your plan will continue; renew before the period ends." };
      default:
        throw new AppError("VALIDATION", "Unknown action.");
    }
  });
  if (target) redirect(target);
  return r;
}

/** Platform administrators only. */
export async function adminBillingAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    if (!s.user.isPlatformAdmin) throw new AppError("FORBIDDEN", "Platform administrators only.");
    const svc = paymentService();
    switch (str(form, "intent")) {
      case "draft_pricing": {
        let items: unknown[];
        try {
          items = JSON.parse(str(form, "items") || "[]");
        } catch {
          throw new AppError("VALIDATION", "Price lines must be valid JSON.");
        }
        if (!Array.isArray(items)) throw new AppError("VALIDATION", "Price lines must be a JSON array.");
        const v = await svc.ledger.draftPricing(s.user.id, { targetMarginBps: Math.round(Number(str(form, "marginPercent")) * 100), notes: str(form, "notes"), items });
        revalidatePath("/app/admin/billing");
        return { success: `Draft pricing version ${v.version} created. Check it, then activate.` };
      }
      case "activate_pricing":
        await svc.ledger.activatePricing(str(form, "versionId"));
        revalidatePath("/app/admin/billing");
        return { success: "Activated. New charges use this version; past charges keep theirs." };
      case "refund": {
        const amount = Math.round(Number(str(form, "amount")) * 100);
        await svc.refund(s.user.id, str(form, "paymentId"), amount, str(form, "reason"));
        revalidatePath("/app/admin/billing");
        return { success: "Refund requested." };
      }
      case "reconcile": {
        const p = await svc.reconcile(str(form, "paymentId"));
        revalidatePath("/app/admin/billing");
        return { success: `Checked with the provider: ${p.status}.` };
      }
      default:
        throw new AppError("VALIDATION", "Unknown action.");
    }
  });
}
