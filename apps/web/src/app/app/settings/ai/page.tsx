import { AI_PROVIDERS } from "@researchmate/database";
import { PROVIDER_INFO } from "@researchmate/ai";
import { ActionForm, Field } from "@/components/action-form";
import { Meter, PageHeader, Section } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { aiCredentialAction } from "@/server/actions/ai";
import { aiService } from "@/server/services";
import { requireWorkspace } from "@/server/session";

export const metadata = { title: "AI keys" };

export default async function AiKeysPage() {
  const { session, org } = await requireWorkspace();
  const [keys, usage] = await Promise.all([aiService().listCredentials(session.user.id, org.organizationId), aiService().usage(org.organizationId)]);
  const isAdmin = org.permissions.has("org.settings.manage");

  return (
    <>
      <PageHeader title="AI keys" description="ResearchMate uses your own AI provider key (bring your own key). Usage is billed by your provider, not by ResearchMate." />
      <Section title="Usage this month">
        {usage.tier === "none" ? (
          <p className="text-sm text-graphite">AI assistance is not included in the {usage.planName} plan.</p>
        ) : (
          <div className="max-w-sm">
            <Meter label="AI runs" used={usage.usedThisMonth} limit={usage.monthlyLimit} format={(n) => String(n)} />
          </div>
        )}
      </Section>

      <Section title="Your keys" description="Keys are encrypted at rest and never shown again in full. Personal keys are used only for your own requests; shared keys can be used by everyone in the organization.">
        {keys.length === 0 && <p className="mb-4 text-sm text-graphite">No keys yet.</p>}
        <ul className="mb-6 grid max-w-3xl gap-2">
          {keys.map((k) => (
            <li key={k.id} className="rounded-md border border-rule bg-sheet p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">
                    {k.label} <span className="font-normal text-graphite">· {PROVIDER_INFO[k.providerKey as keyof typeof PROVIDER_INFO].name} · {k.keyHint}</span>
                  </p>
                  <p className="text-xs text-graphite">
                    Model {k.defaultModel}
                    {k.baseUrl ? ` · ${k.baseUrl}` : ""} · {k.scope === "organization" ? `shared by ${k.ownerName ?? "an admin"}` : "personal"} · {k.lastUsedAt ? `last used ${formatDateTime(k.lastUsedAt)}` : "not used yet"}
                  </p>
                  {k.lastError && <p className="mt-1 text-xs text-margin">Last error: {k.lastError}</p>}
                </div>
                <div className="flex gap-2">
                  <ActionForm action={aiCredentialAction} submitLabel="Test" variant="quiet" className="flex">
                    <input type="hidden" name="intent" value="test" />
                    <input type="hidden" name="credentialId" value={k.id} />
                  </ActionForm>
                  {(k.userId === session.user.id || isAdmin) && (
                    <ActionForm action={aiCredentialAction} submitLabel="Remove" variant="danger" className="flex">
                      <input type="hidden" name="intent" value="revoke" />
                      <input type="hidden" name="credentialId" value={k.id} />
                    </ActionForm>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="max-w-3xl rounded-md border border-rule bg-sheet p-4">
          <h3 className="mb-3 font-sans text-base font-semibold">Add a key</h3>
          <ActionForm action={aiCredentialAction} submitLabel="Save key" resetOnSuccess className="grid gap-4">
            <input type="hidden" name="intent" value="add" />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="field">
                <label htmlFor="k-provider">Provider</label>
                <select id="k-provider" name="providerKey" className="input">
                  {AI_PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_INFO[p].name}</option>)}
                </select>
              </div>
              <Field id="k-label" label="Name" name="label" placeholder="e.g. My OpenAI key" required maxLength={100} />
              <Field id="k-key" label="API key" name="apiKey" type="password" autoComplete="off" required />
              <Field id="k-model" label="Model" name="defaultModel" required hint="The exact model id from your provider, e.g. one listed in its console." />
              <Field id="k-url" label="Base URL" name="baseUrl" type="url" hint="Only for OpenAI-compatible endpoints (self-hosted, OpenRouter, etc.). Must be https." />
              {isAdmin && (
                <div className="field">
                  <label htmlFor="k-scope">Who can use it</label>
                  <select id="k-scope" name="scope" className="input" defaultValue="user">
                    <option value="user">Only me</option>
                    <option value="organization">Everyone in {org.organizationName}</option>
                  </select>
                </div>
              )}
            </div>
          </ActionForm>
        </div>
        <p className="mt-4 max-w-3xl text-xs text-graphite">If a request with your key fails, ResearchMate stops and tells you why. It never retries with a different key or with a platform-paid model.</p>
      </Section>
    </>
  );
}
