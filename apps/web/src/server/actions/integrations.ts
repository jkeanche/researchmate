"use server";

import { AppError } from "@researchmate/shared";
import { revalidatePath } from "next/cache";
import { type FormState, handle, str } from "../form";
import { apifyService, literatureService, mcpService, webCaptureService } from "../services";
import { requireSession, requireWorkspace } from "../session";

/** Organization settings: MCP registry, Apify connection, approved websites. */
export async function integrationSettingsAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const { session, org } = await requireWorkspace();
    const uid = session.user.id;
    const done = (m: string) => (revalidatePath("/app/settings/integrations"), { success: m });
    switch (str(form, "intent")) {
      case "mcp_add": {
        const i = await mcpService().add(uid, org.organizationId, { name: str(form, "name"), url: str(form, "url"), authHeaderName: str(form, "authHeaderName") || undefined, secret: str(form, "secret"), timeoutMs: str(form, "timeoutMs") || undefined, monthlyCallLimit: str(form, "monthlyCallLimit") ? Number(str(form, "monthlyCallLimit")) : null });
        return done(`Added “${i.name}”. Discover its tools next, then approve the ones you want.`);
      }
      case "mcp_discover": {
        const tools = await mcpService().discover(uid, str(form, "integrationId"));
        return done(`Found ${tools.length} tool${tools.length === 1 ? "" : "s"}. Nothing is callable until you approve tools.`);
      }
      case "mcp_approve":
        await mcpService().approve(uid, str(form, "integrationId"), form.getAll("tools").map(String));
        return done("Approved tools are now available to the AI assistant for project editors.");
      case "mcp_enable":
      case "mcp_disable":
        await mcpService().setEnabled(uid, str(form, "integrationId"), str(form, "intent") === "mcp_enable");
        return done("Saved.");
      case "mcp_remove":
        await mcpService().remove(uid, str(form, "integrationId"));
        return done("Integration removed. Its call history is kept.");
      case "apify_connect":
        await apifyService().connect(uid, org.organizationId, str(form, "token"));
        return done("Apify account connected. Actor runs will be billed to it by Apify.");
      case "apify_disconnect":
        await apifyService().disconnect(uid, org.organizationId);
        return done("Apify account disconnected.");
      case "domain_add":
        await (await webCaptureService()).addDomain(uid, org.organizationId, str(form, "domain"));
        return done("Website approved.");
      case "domain_remove":
        await (await webCaptureService()).removeDomain(uid, org.organizationId, str(form, "domain"));
        return done("Website removed.");
      default:
        throw new AppError("VALIDATION", "Unknown action.");
    }
  });
}

/** Project research: capture approved web pages, run approved Apify Actors, add results to the library. */
export async function webResearchAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const done = (m: string) => (revalidatePath(`/app/projects/${projectId}/literature`, "layout"), { success: m });
    switch (str(form, "intent")) {
      case "capture": {
        const r = await (await webCaptureService()).capture(s.user.id, projectId, str(form, "url"));
        return done(r.duplicate ? `“${r.title}” was already in the library; the new snapshot is attached.` : `Captured “${r.title}”: a dated snapshot is in the project files and the page is in the library.`);
      }
      case "apify_run": {
        const input: Record<string, unknown> = {};
        for (const [k, v] of form.entries()) if (k.startsWith("in_") && typeof v === "string" && v.trim()) input[k.slice(3)] = v;
        await apifyService().start(s.user.id, projectId, str(form, "actorKey"), input);
        return done("Started. Results appear below when the Actor finishes.");
      }
      case "apify_add": {
        const run = await apifyService().get(s.user.id, str(form, "runId"));
        const item = run.results?.[Number(str(form, "index"))] as { url?: string; title?: string } | undefined;
        if (!item?.url) throw new AppError("VALIDATION", "That result has no address.");
        const r = await literatureService().addManual(s.user.id, projectId, { type: "webpage", title: item.title || item.url, url: item.url });
        return done(`Added as [@${r.citationKey}] (unverified). Capture the page from an approved website to keep its text.`);
      }
      default:
        throw new AppError("VALIDATION", "Unknown action.");
    }
  });
}
