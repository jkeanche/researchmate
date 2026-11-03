"use server";

import { AppError } from "@researchmate/shared";
import { revalidatePath } from "next/cache";
import { type FormState, handle, str } from "../form";
import { financeService } from "../services";
import { requireSession } from "../session";

const refresh = (projectId: string) => revalidatePath(`/app/projects/${projectId}`, "layout");
const fields = (form: FormData, keys: string[]) => Object.fromEntries(keys.map((k) => [k, str(form, k)]));

export async function financeSettingsAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const enabled = str(form, "enabled") !== "false";
    await financeService().configure(s.user.id, projectId, { enabled, baseCurrency: str(form, "baseCurrency") || undefined, alertThresholdPercent: str(form, "alertThresholdPercent") || undefined, notes: form.has("notes") ? str(form, "notes") : undefined });
    refresh(projectId);
    return { success: enabled ? "Financial tracking is on." : "Financial tracking is off. Records are kept and come back if you turn it on again." };
  });
}

export async function budgetAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const svc = financeService();
    const intent = str(form, "intent");
    if (intent === "draft") await svc.draft(s.user.id, projectId);
    else if (intent === "approve") await svc.approveBudget(s.user.id, str(form, "versionId"));
    else if (intent === "discard") await svc.discardDraft(s.user.id, str(form, "versionId"));
    else if (intent === "save") {
      const versionId = str(form, "versionId");
      await svc.updateDraftDetails(s.user.id, versionId, { name: str(form, "name"), notes: str(form, "notes") });
      // One input per category: "line:<categoryKey>" holds the amount.
      for (const [k, v] of form.entries()) {
        if (!k.startsWith("line:") || typeof v !== "string") continue;
        const prev = str(form, `prev:${k.slice(5)}`);
        if (v.trim() === prev.trim()) continue;
        await svc.setAllocation(s.user.id, versionId, { categoryKey: k.slice(5), amount: v || "0" });
      }
    } else throw new AppError("VALIDATION", "Unknown action.");
    refresh(projectId);
    return { success: intent === "approve" ? "Budget approved. Earlier versions are kept." : intent === "discard" ? "Draft discarded." : intent === "save" ? "Draft saved." : "Draft started." };
  });
}

export async function expenseAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const svc = financeService();
    const intent = str(form, "intent");
    const input = {
      ...fields(form, ["description", "categoryKey", "expenseDate", "vendor", "paymentMethod", "taskId", "fundingSourceId", "notes", "amount", "currency", "fxRate"]),
      recurring: form.get("recurring") === "on",
    };
    if (intent === "create" || intent === "create_submit") await svc.createExpense(s.user.id, projectId, { ...input, submit: intent === "create_submit" });
    else if (intent === "update") await svc.updateExpense(s.user.id, str(form, "expenseId"), input, Number(str(form, "version")) || undefined);
    else if (intent === "delete") await svc.deleteExpense(s.user.id, str(form, "expenseId"));
    else if (intent === "attach") await svc.attachReceipt(s.user.id, str(form, "expenseId"), str(form, "fileId"));
    else if (["submit", "approve", "reject", "pay", "reimburse", "cancel"].includes(intent)) {
      const r = await svc.transitionExpense(s.user.id, str(form, "expenseId"), intent as never, { note: str(form, "note"), paidAt: str(form, "paidAt") || undefined });
      refresh(projectId);
      return { success: r.selfApproved ? "Approved. You also submitted this expense; that is recorded." : "Updated." };
    } else throw new AppError("VALIDATION", "Unknown action.");
    refresh(projectId);
    return { success: intent.startsWith("create") ? "Expense recorded." : intent === "attach" ? "Receipt attached." : intent === "delete" ? "Draft deleted." : "Expense saved." };
  });
}

export async function fundingAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const svc = financeService();
    const intent = str(form, "intent");
    if (intent === "source") await svc.createFundingSource(s.user.id, projectId, fields(form, ["name", "kind", "funderName", "reference", "currency", "awarded", "startDate", "endDate", "reportingPeriod", "notes"]));
    else if (intent === "receipt") await svc.recordReceipt(s.user.id, str(form, "fundingSourceId"), { receivedDate: str(form, "receivedDate"), amount: str(form, "amount"), fxRate: str(form, "fxRate"), note: str(form, "note") });
    else if (intent === "rate") await svc.addRate(s.user.id, projectId, { fromCurrency: str(form, "fromCurrency"), toCurrency: str(form, "toCurrency"), rate: str(form, "rate"), rateDate: str(form, "rateDate") });
    else if (intent === "category") await svc.addCategory(s.user.id, projectId, str(form, "name"));
    else throw new AppError("VALIDATION", "Unknown action.");
    refresh(projectId);
    return { success: intent === "source" ? "Funding source added." : intent === "receipt" ? "Receipt recorded." : intent === "rate" ? "Rate saved." : "Category added." };
  });
}

export async function estimateAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    await financeService().setEstimate(s.user.id, str(form, "taskId"), { categoryKey: str(form, "categoryKey"), amount: str(form, "amount") || "0", note: str(form, "note") });
    refresh(str(form, "projectId"));
    return { success: "Estimate saved." };
  });
}
