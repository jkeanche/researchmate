"use server";

import { AppError } from "@researchmate/shared";
import { revalidatePath } from "next/cache";
import { type FormState, handle, str } from "../form";
import { aiService, driveService } from "../services";
import { requireSession, requireWorkspace } from "../session";

// ----- AI keys -------------------------------------------------------------

export async function aiCredentialAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const { session, org } = await requireWorkspace();
    const intent = str(form, "intent");
    if (intent === "add") {
      await aiService().addCredential(session.user.id, org.organizationId, {
        providerKey: str(form, "providerKey"),
        label: str(form, "label"),
        apiKey: str(form, "apiKey"),
        defaultModel: str(form, "defaultModel"),
        baseUrl: str(form, "baseUrl"),
        scope: str(form, "scope") || "user",
      });
      revalidatePath("/app/settings/ai");
      return { success: "Key saved. Only the last four characters are ever shown again." };
    }
    if (intent === "revoke") {
      await aiService().revokeCredential(session.user.id, str(form, "credentialId"));
      revalidatePath("/app/settings/ai");
      return { success: "Key removed." };
    }
    if (intent === "test") {
      const r = await aiService().testCredential(session.user.id, str(form, "credentialId"));
      revalidatePath("/app/settings/ai");
      return r.ok ? { success: "The key works." } : { error: r.message };
    }
    throw new AppError("VALIDATION", "Unknown action.");
  });
}

// ----- Agent runs ----------------------------------------------------------

export async function startAgentAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const input: Record<string, unknown> = {};
    for (const k of ["question", "guidance", "startDate", "submissionDate", "referenceId", "focus", "reviewRequestId"]) if (str(form, k)) input[k] = str(form, k);
    const payWith = str(form, "payWith");
    const credentialId = payWith.startsWith("key:") ? payWith.slice(4) : str(form, "credentialId") || null;
    const funding = payWith === "platform" ? "platform" : payWith.startsWith("key:") ? "byok" : undefined;
    await aiService().startRun(s.user.id, projectId, str(form, "agentKey"), input, credentialId, funding);
    revalidatePath(`/app/projects/${projectId}/assistant`);
    return { success: "Started. Results appear below when ready." };
  });
}

export async function aiRunControlAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const intent = str(form, "intent");
    if (intent === "cancel") await aiService().cancelRun(s.user.id, str(form, "runId"));
    else if (intent === "accept" || intent === "dismiss") await aiService().decideSuggestion(s.user.id, str(form, "suggestionId"), intent);
    else throw new AppError("VALIDATION", "Unknown action.");
    revalidatePath(`/app/projects/${projectId}`, "layout");
    return { success: intent === "accept" ? "Added to the project." : intent === "dismiss" ? "Dismissed." : "Cancelling." };
  });
}

// ----- Google Drive --------------------------------------------------------

export async function driveAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const { session, org } = await requireWorkspace();
    const svc = await driveService();
    const intent = str(form, "intent");
    if (intent === "disconnect") {
      await svc.disconnect(session.user.id, org.organizationId);
      revalidatePath("/app/settings/integrations");
      return { success: "Google Drive disconnected and access revoked." };
    }
    if (intent === "import") {
      await svc.requestImport(session.user.id, org.organizationId, str(form, "externalId"), str(form, "projectId") || null);
      revalidatePath("/app/settings/integrations");
      return { success: "Import started." };
    }
    if (intent === "export") {
      await svc.requestExport(session.user.id, org.organizationId, str(form, "fileId"), str(form, "folderId") || null);
      revalidatePath("/app/settings/integrations");
      return { success: "Export to Google Drive started. Progress is shown on the Integrations page." };
    }
    throw new AppError("VALIDATION", "Unknown action.");
  });
}
