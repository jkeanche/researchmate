import { canUseFeature } from "@researchmate/entitlements";
import { ActionForm, Field } from "@/components/action-form";
import { Notice, PlanNotice, Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { integrationSettingsAction } from "@/server/actions/integrations";
import { apifyService, db, mcpService, webCaptureService } from "@/server/services";

/** MCP registry, Apify connection and approved websites (organization settings). */
export async function IntegrationSettings({ userId, organizationId, canManage }: { userId: string; organizationId: string; canManage: boolean }) {
  const [mcpOk, apifyOk, integrations, apifyConn, domains] = await Promise.all([
    canUseFeature(db(), organizationId, "integrations.mcp"),
    canUseFeature(db(), organizationId, "integrations.apify"),
    mcpService().list(userId, organizationId),
    apifyService().connection(organizationId),
    webCaptureService().then((w) => w.domains(organizationId)),
  ]);
  const intent = (v: string) => <input type="hidden" name="intent" value={v} />;
  return (
    <>
      <Section title="MCP tools" description="Connect remote MCP servers (Streamable HTTP). Nothing is callable until an admin approves specific tools. Approved tools are offered to the AI assistant for project editors; their output is treated as untrusted data, and every call is logged.">
        {!mcpOk ? (
          <PlanNotice>MCP integrations are not included in your plan.</PlanNotice>
        ) : (
          <>
            <ul className="mb-4 grid gap-3">
              {integrations.map((i) => (
                <li key={i.id} className="rounded-md border border-rule bg-sheet p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold">{i.name} <span className="font-normal text-graphite">· {i.url}{i.hasSecret ? ` · credential ${i.secretHint}` : ""}{i.monthlyCallLimit ? ` · ${i.monthlyCallLimit} calls/month` : ""}</span></p>
                    <Tag tone={i.status === "active" && i.enabled ? "done" : i.status === "error" ? "blocked" : "awaiting_approval"}>{i.enabled ? "Active" : i.status === "pending_review" ? "Needs review" : i.status === "error" ? "Error" : "Disabled"}</Tag>
                  </div>
                  {i.lastError && <p className="mt-1 text-margin">{i.lastError}</p>}
                  {canManage && (
                    <div className="mt-3 grid gap-3">
                      {i.toolCatalog.length > 0 && (
                        <ActionForm action={integrationSettingsAction} submitLabel="Approve selected tools" variant="quiet" className="grid gap-2">
                          {intent("mcp_approve")}
                          <input type="hidden" name="integrationId" value={i.id} />
                          <fieldset className="grid gap-1">
                            <legend className="text-xs text-graphite">Discovered tools</legend>
                            {i.toolCatalog.map((t) => (
                              <label key={t.name} className="flex items-start gap-2">
                                <input type="checkbox" name="tools" value={t.name} defaultChecked={i.approvedTools.some((a) => a.name === t.name)} className="mt-1" />
                                <span><code>{t.name}</code> <span className="text-graphite">{t.description.slice(0, 200)}</span></span>
                              </label>
                            ))}
                          </fieldset>
                        </ActionForm>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {[["mcp_discover", "Discover tools"], [i.enabled ? "mcp_disable" : "mcp_enable", i.enabled ? "Disable" : "Enable"], ["mcp_remove", "Remove"]].map(([k, l]) => (
                          <ActionForm key={k} action={integrationSettingsAction} submitLabel={l!} variant={k === "mcp_remove" ? "danger" : "quiet"} className="flex">
                            {intent(k!)}
                            <input type="hidden" name="integrationId" value={i.id} />
                          </ActionForm>
                        ))}
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {canManage && (
              <ActionForm action={integrationSettingsAction} submitLabel="Add MCP server" resetOnSuccess className="grid max-w-2xl gap-3 sm:grid-cols-2">
                {intent("mcp_add")}
                <Field id="mcp-name" label="Name" name="name" required maxLength={80} />
                <Field id="mcp-url" label="Server URL" name="url" type="url" required placeholder="https://…/mcp" />
                <Field id="mcp-header" label="Auth header (optional)" name="authHeaderName" placeholder="Authorization" maxLength={60} />
                <Field id="mcp-secret" label="Credential (optional)" name="secret" type="password" autoComplete="off" placeholder="Bearer …" />
                <Field id="mcp-limit" label="Monthly call limit" name="monthlyCallLimit" type="number" min={1} />
                <Field id="mcp-timeout" label="Timeout (ms)" name="timeoutMs" type="number" min={1000} max={120000} defaultValue={20000} />
              </ActionForm>
            )}
          </>
        )}
      </Section>

      <Section title="Apify" description="Run approved Apify Actors (web crawling, search results) from a project. With your own Apify account, Apify bills you directly; ResearchMate doesn't charge for those runs.">
        {!apifyOk ? (
          <PlanNotice>Apify is not included in your plan.</PlanNotice>
        ) : apifyConn ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>Connected (token {apifyConn.tokenHint}).</span>
            {canManage && (
              <ActionForm action={integrationSettingsAction} submitLabel="Disconnect" variant="quiet" className="flex">
                {intent("apify_disconnect")}
              </ActionForm>
            )}
          </div>
        ) : canManage ? (
          <ActionForm action={integrationSettingsAction} submitLabel="Connect Apify" className="flex max-w-xl flex-wrap items-end gap-2">
            {intent("apify_connect")}
            <Field id="apify-token" label="Apify API token" name="token" type="password" autoComplete="off" required />
          </ActionForm>
        ) : (
          <Notice>An organization admin can connect an Apify account.</Notice>
        )}
      </Section>

      <Section title="Approved websites" description="Public websites researchers may capture as sources (a dated text snapshot is stored with the project). Subdomains are included.">
        <ul className="mb-3 flex flex-wrap gap-2 text-sm">
          {domains.platform.map((d) => <li key={`p-${d}`}><Tag tone="todo">{d} (platform)</Tag></li>)}
          {domains.organization.map((d) => (
            <li key={d} className="flex items-center gap-1">
              <Tag tone="done">{d}</Tag>
              {canManage && (
                <ActionForm action={integrationSettingsAction} submitLabel="×" variant="quiet" className="flex">
                  {intent("domain_remove")}
                  <input type="hidden" name="domain" value={d} />
                </ActionForm>
              )}
            </li>
          ))}
          {!domains.platform.length && !domains.organization.length && <li className="text-graphite">None yet.</li>}
        </ul>
        {canManage && (
          <ActionForm action={integrationSettingsAction} submitLabel="Approve website" variant="quiet" resetOnSuccess className="flex flex-wrap items-end gap-2">
            {intent("domain_add")}
            <Field id="dom" label="Domain" name="domain" required placeholder="who.int" maxLength={200} />
          </ActionForm>
        )}
      </Section>
    </>
  );
}
