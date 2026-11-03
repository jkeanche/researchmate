import { EXPENSE_STATUSES, files as filesTable, FUNDING_KINDS, PAYMENT_METHODS } from "@researchmate/database";
import { BUCKET, type ExpenseStatus, formatMoney, REPORTS, toDecimalString } from "@researchmate/finance";
import { and, eq, isNull } from "drizzle-orm";
import { ActionForm, Field } from "@/components/action-form";
import { Notice, PlanNotice, Stat, Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import { budgetAction, expenseAction, financeSettingsAction, fundingAction } from "@/server/actions/finance";
import { loadPlanView } from "@/server/plan";
import { db, financeService } from "@/server/services";

export const metadata = { title: "Finances" };

const CURRENCIES = ["KES", "USD", "EUR", "GBP", "UGX", "TZS", "RWF", "ETB", "NGN", "GHS", "ZAR", "INR", "CNY", "JPY", "CAD", "AUD", "CHF", "SEK"];
const STATUS_LABEL: Record<string, string> = { draft: "Draft", submitted: "Submitted", approved: "Approved", rejected: "Rejected", paid: "Paid", reimbursed: "Reimbursed", cancelled: "Cancelled" };
const STATUS_TONE: Record<string, string> = { draft: "todo", submitted: "in_review", approved: "in_progress", rejected: "blocked", paid: "done", reimbursed: "done", cancelled: "cancelled" };
const BUCKET_LABEL = { pending: "Pending", committed: "Committed", actual: "Actual" } as const;
const KIND_LABEL: Record<string, string> = { personal: "Personal", institutional: "Institutional", grant: "Grant", scholarship: "Scholarship", sponsor: "Sponsor", other: "Other" };
const METHOD_LABEL: Record<string, string> = { cash: "Cash", mobile_money: "Mobile money", bank_transfer: "Bank transfer", card: "Card", cheque: "Cheque", invoice: "Invoice", other: "Other" };

function CurrencyInput({ name, defaultValue, label = "Currency", idSuffix = "" }: { name: string; defaultValue: string; label?: string; idSuffix?: string }) {
  return (
    <div className="field">
      <label htmlFor={`cur-${name}${idSuffix}`}>{label}</label>
      <input id={`cur-${name}${idSuffix}`} name={name} className="input uppercase" list="currency-list" defaultValue={defaultValue} maxLength={3} pattern="[A-Za-z]{3}" required />
    </div>
  );
}

export default async function FinancePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const v = await loadPlanView(projectId);
  const uid = v.session.user.id;
  const svc = financeService();
  const s = await svc.getSettings(uid, projectId);
  const hidden = <input type="hidden" name="projectId" value={projectId} />;
  const canManage = v.can("finance.manage") && !v.archived && s.entitled;
  const canApprove = v.can("finance.approve") && !v.archived && s.entitled;

  if (!s.canRead) return <Notice>You don’t have access to this project’s finances. Financial access is granted separately from research access.</Notice>;

  if (!s.settings?.enabled) {
    return (
      <Section title="Project finances" description="Optional. Use it if the project has a budget, a grant, sponsors or costs you want to track. Projects without funding can leave it off.">
        {!s.entitled ? (
          <PlanNotice>Budget management is not included in the {s.planName} plan.</PlanNotice>
        ) : v.can("finance.manage") && !v.archived ? (
          <div className="max-w-xl">
            <ActionForm action={financeSettingsAction} submitLabel="Turn on financial tracking" className="grid gap-4 sm:grid-cols-2">
              {hidden}
              <input type="hidden" name="enabled" value="true" />
              <CurrencyInput name="baseCurrency" label="Reporting currency" defaultValue={s.settings?.baseCurrency ?? "KES"} />
              <Field label="Alert at (% of budget used)" name="alertThresholdPercent" type="number" min={1} max={100} defaultValue={s.settings?.alertThresholdPercent ?? 80} />
              <datalist id="currency-list">{CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
            </ActionForm>
            {s.settings && <p className="mt-3 text-sm text-graphite">Earlier records are kept and will reappear.</p>}
          </div>
        ) : (
          <Notice>Financial tracking is off for this project.</Notice>
        )}
      </Section>
    );
  }

  const base = s.settings.baseCurrency;
  const M = (n: number) => formatMoney(n, base);
  const [d, expenses, funding, rates, cats, audit, projectFiles] = await Promise.all([
    svc.dashboard(uid, projectId),
    svc.listExpenses(uid, projectId),
    svc.listFunding(uid, projectId),
    svc.listRates(v.project.organizationId),
    svc.categories(v.project.organizationId),
    svc.auditTrail(uid, projectId, 40),
    db().select({ id: filesTable.id, name: filesTable.originalName }).from(filesTable).where(and(eq(filesTable.projectId, projectId), isNull(filesTable.deletedAt))),
  ]);
  const catName = new Map(cats.map((c) => [c.key, c.name]));
  const used = d.committed + d.actual;
  const alert = d.budget > 0 && (used / d.budget) * 100 >= s.settings.alertThresholdPercent;
  const draftLines = new Map((d.draft?.lines ?? []).filter((l) => !l.fundingSourceId).map((l) => [l.categoryKey, l.amountBaseMinor]));
  const maxMonth = Math.max(1, ...d.monthly.map((m) => m.actual + m.committed));
  const tasks = v.tasks.filter((t) => !t.isSummary);

  return (
    <>
      <datalist id="currency-list">{CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
      {!s.entitled && <div className="mb-6"><PlanNotice>Your plan no longer includes budget management. Records stay readable; changes are disabled.</PlanNotice></div>}

      <Section title="Summary" description={`All figures in ${base}. Pending, committed and actual never overlap, so nothing is counted twice.`}>
        {alert && <p role="alert" className="mb-4 rounded-md border border-margin/30 bg-margin-wash px-3 py-2 text-sm text-margin">{d.utilisationPercent}% of the approved budget is committed or spent (alert threshold {s.settings.alertThresholdPercent}%).</p>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Approved budget" value={d.approved ? M(d.budget) : "—"} note={d.approved ? `Version ${d.approved.number} · ${d.approved.name}` : "No approved budget yet"} />
          <Stat label="Actual expenditure" value={M(d.actual)} note="Paid or reimbursed" />
          <Stat label="Committed" value={M(d.committed)} note="Approved, not yet paid" />
          <Stat label="Pending approval" value={M(d.pending)} note="Submitted" />
          <Stat label="Remaining" value={d.approved ? M(d.remaining) : "—"} tone={d.approved && d.remaining < 0 ? "bad" : undefined} note="Budget − committed − actual" />
          <Stat label="Budget used" value={d.utilisationPercent === null ? "—" : `${d.utilisationPercent}%`} tone={alert ? "bad" : undefined} />
          <Stat label="Funding received" value={M(d.receivedBase)} note={`${funding.sources.length} source(s)`} />
          <Stat label="Forecast total cost" value={M(d.forecast)} tone={d.approved && d.forecast > d.budget ? "warn" : undefined} note={d.outstandingEstimates ? `Includes ${M(d.outstandingEstimates)} of task estimates` : "Spending to date"} />
        </div>

        {d.categories.length > 0 && (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-graphite">
                <tr className="border-b border-rule">
                  <th className="py-2 pr-3 font-semibold">Category</th>
                  {["Budget", "Task estimates", "Actual", "Committed", "Pending", "Remaining"].map((h) => (
                    <th key={h} className="py-2 pr-3 text-right font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="ruled tabular-nums">
                {d.categories.map((c) => {
                  const rem = c.budget - c.committed - c.actual;
                  return (
                    <tr key={c.key}>
                      <td className="py-1.5 pr-3">{c.name}</td>
                      <td className="py-1.5 pr-3 text-right">{c.budget ? M(c.budget) : "—"}</td>
                      <td className="py-1.5 pr-3 text-right text-graphite">{c.estimated ? M(c.estimated) : "—"}</td>
                      <td className="py-1.5 pr-3 text-right">{c.actual ? M(c.actual) : "—"}</td>
                      <td className="py-1.5 pr-3 text-right">{c.committed ? M(c.committed) : "—"}</td>
                      <td className="py-1.5 pr-3 text-right text-graphite">{c.pending ? M(c.pending) : "—"}</td>
                      <td className={`py-1.5 pr-3 text-right ${rem < 0 ? "font-semibold text-margin" : ""}`}>{c.budget || rem ? M(rem) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {d.monthly.length > 0 && (
          <figure className="mt-6">
            <figcaption className="mb-2 text-sm font-semibold">Spending by month</figcaption>
            <ul className="grid gap-1.5 text-xs">
              {d.monthly.map((m) => (
                <li key={m.month} className="grid grid-cols-[4.5rem_1fr_7.5rem] items-center gap-3">
                  <span className="tabular-nums text-graphite">{m.month}</span>
                  <span className="flex h-3 overflow-hidden rounded-sm bg-rule-soft" aria-label={`${m.month}: actual ${M(m.actual)}, committed ${M(m.committed)}`}>
                    <span className="h-full bg-green" style={{ width: `${(m.actual / maxMonth) * 100}%` }} />
                    <span className="h-full bg-amber/60" style={{ width: `${(m.committed / maxMonth) * 100}%` }} />
                  </span>
                  <span className="text-right tabular-nums">{M(m.actual + m.committed)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-graphite"><span className="mr-1 inline-block h-2 w-3 bg-green align-middle" />Actual <span className="mr-1 ml-3 inline-block h-2 w-3 bg-amber/60 align-middle" />Committed</p>
          </figure>
        )}
      </Section>

      <Section title="Budget" description="Approving a budget freezes it. Revisions are new versions; every approved version is kept.">
        {d.approved && (
          <p className="mb-4 text-sm">
            <strong>Approved:</strong> version {d.approved.number}, “{d.approved.name}”, {M(d.approved.totalBaseMinor)} · approved {formatDateTime(d.approved.approvedAt)}
          </p>
        )}
        {d.draft ? (
          canManage || canApprove ? (
            <div className="grid max-w-3xl gap-4 rounded-md border border-amber/30 bg-sheet p-4">
              <p className="text-sm font-semibold">Draft: version {d.draft.number} · total {M(d.draft.totalBaseMinor)}</p>
              {canManage && (
                <ActionForm action={budgetAction} submitLabel="Save draft" className="grid gap-4">
                  {hidden}
                  <input type="hidden" name="intent" value="save" />
                  <input type="hidden" name="versionId" value={d.draft.id} />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field id="b-name" label="Name" name="name" defaultValue={d.draft.name} maxLength={200} />
                    <Field id="b-notes" label="Notes" name="notes" defaultValue={d.draft.notes} maxLength={2000} />
                  </div>
                  <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                    {cats.map((c) => {
                      const val = draftLines.has(c.key) ? toDecimalString(draftLines.get(c.key)!, base) : "";
                      return (
                        <label key={c.key} className="grid grid-cols-[1fr_9rem] items-center gap-2 text-sm">
                          <span>{c.name}</span>
                          <input name={`line:${c.key}`} className="input py-1 text-right tabular-nums" inputMode="decimal" defaultValue={val} placeholder="0" aria-label={`${c.name} (${base})`} />
                          <input type="hidden" name={`prev:${c.key}`} value={val} />
                        </label>
                      );
                    })}
                  </div>
                </ActionForm>
              )}
              <div className="flex flex-wrap gap-2">
                {canApprove && (
                  <ActionForm action={budgetAction} submitLabel="Approve this budget" className="flex">
                    {hidden}
                    <input type="hidden" name="intent" value="approve" />
                    <input type="hidden" name="versionId" value={d.draft.id} />
                  </ActionForm>
                )}
                {canManage && (
                  <ActionForm action={budgetAction} submitLabel="Discard draft" variant="quiet" className="flex">
                    {hidden}
                    <input type="hidden" name="intent" value="discard" />
                    <input type="hidden" name="versionId" value={d.draft.id} />
                  </ActionForm>
                )}
              </div>
            </div>
          ) : (
            <Notice>A draft revision is being prepared.</Notice>
          )
        ) : canManage ? (
          <ActionForm action={budgetAction} submitLabel={d.approved ? "Start a revision" : "Create a budget"} className="flex">
            {hidden}
            <input type="hidden" name="intent" value="draft" />
          </ActionForm>
        ) : null}
        {canManage && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-graphite">Add a custom category</summary>
            <div className="mt-2 max-w-md">
              <ActionForm action={fundingAction} submitLabel="Add category" resetOnSuccess className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                {hidden}
                <input type="hidden" name="intent" value="category" />
                <Field id="c-name" label="Category name" name="name" required maxLength={100} />
              </ActionForm>
            </div>
          </details>
        )}
      </Section>

      <Section title="Expenses">
        {canManage && (
          <div className="mb-8 max-w-3xl rounded-md border border-rule bg-sheet p-4">
            <h3 className="mb-3 font-sans text-base font-semibold">Record an expense</h3>
            <div>
              <ActionForm action={expenseAction} submitLabel="Save as draft" resetOnSuccess className="grid gap-4">
                {hidden}
                <input type="hidden" name="intent" value="create" />
                <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
                  <Field label="Description" name="description" required maxLength={500} />
                  <div className="field">
                    <label htmlFor="x-cat">Category</label>
                    <select id="x-cat" name="categoryKey" className="input" required>
                      {cats.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-4">
                  <Field label="Date" name="expenseDate" type="date" defaultValue={v.today} required />
                  <Field id="x-amount" label="Amount" name="amount" inputMode="decimal" required />
                  <CurrencyInput name="currency" idSuffix="x" defaultValue={base} />
                  <Field id="x-fx" label="Exchange rate" name="fxRate" inputMode="decimal" hint={`Only for other currencies: ${base} per unit. Leave empty to use a saved rate.`} />
                </div>
                <div className="grid gap-4 sm:grid-cols-4">
                  <Field label="Vendor or payee" name="vendor" maxLength={200} />
                  <div className="field">
                    <label htmlFor="x-method">Paid by</label>
                    <select id="x-method" name="paymentMethod" className="input" defaultValue="mobile_money">
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="x-task">Task</label>
                    <select id="x-task" name="taskId" className="input" defaultValue="">
                      <option value="">—</option>
                      {tasks.map((t) => <option key={t.id} value={t.id}>{t.wbs} {t.title}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="x-fund">Funded by</label>
                    <select id="x-fund" name="fundingSourceId" className="input" defaultValue="">
                      <option value="">—</option>
                      {funding.sources.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
                  <Field id="x-notes" label="Notes" name="notes" maxLength={2000} />
                  <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="recurring" /> Recurring</label>
                </div>
                <p className="text-xs text-graphite">Save as a draft, then submit it for approval from the list. Attach receipts after uploading them on the Overview tab.</p>
              </ActionForm>
            </div>
          </div>
        )}
        {expenses.length === 0 ? (
          <p className="text-sm text-graphite">No expenses recorded.</p>
        ) : (
          <ul className="grid gap-2">
            {expenses.map(({ e, taskTitle, submitter, attachments, history }) => {
              const bucket = BUCKET[e.status as ExpenseStatus];
              const act = (intent: string, label: string, opts: { note?: boolean; variant?: "primary" | "quiet" | "danger"; date?: boolean } = {}) => (
                <ActionForm key={intent} action={expenseAction} submitLabel={label} variant={opts.variant ?? "quiet"} className={opts.note || opts.date ? "grid gap-1.5" : "flex"}>
                  {hidden}
                  <input type="hidden" name="intent" value={intent} />
                  <input type="hidden" name="expenseId" value={e.id} />
                  {opts.note && <input name="note" className="input py-1 text-sm" placeholder="Reason" aria-label="Reason" required maxLength={1000} />}
                  {opts.date && <input name="paidAt" type="date" className="input py-1 text-sm" defaultValue={v.today} aria-label="Date paid" />}
                </ActionForm>
              );
              return (
                <li key={e.id} className="rounded-md border border-rule bg-sheet p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">{e.description}</p>
                      <p className="mt-0.5 text-xs text-graphite">
                        {formatDate(e.expenseDate)} · {catName.get(e.categoryKey) ?? e.categoryKey}
                        {e.vendor ? ` · ${e.vendor}` : ""}
                        {taskTitle ? ` · ${taskTitle}` : ""}
                        {submitter ? ` · submitted by ${submitter}` : ""}
                      </p>
                      {attachments.length > 0 && (
                        <p className="mt-1 text-xs">
                          Receipts: {attachments.map((a, i) => <span key={a.fileId}>{i ? ", " : ""}<a href={`/api/files/${a.fileId}/download`}>{a.name}</a></span>)}
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="font-semibold tabular-nums">{formatMoney(e.amountMinor, e.currency)}</p>
                      {e.currency !== base && <p className="text-xs text-graphite tabular-nums">{M(e.baseAmountMinor)} at {String(e.fxRate).replace(/\.?0+$/, "")} ({e.fxDate})</p>}
                      <p className="mt-1 flex justify-end gap-1">
                        <Tag tone={STATUS_TONE[e.status]!}>{STATUS_LABEL[e.status]}</Tag>
                        {bucket && <span className="text-xs text-graphite">counts as {BUCKET_LABEL[bucket].toLowerCase()}</span>}
                      </p>
                    </div>
                  </div>
                  {(canManage || canApprove) && !["cancelled", "reimbursed"].includes(e.status) && (
                    <div className="mt-3 flex flex-wrap items-start gap-2 border-t border-rule-soft pt-3">
                      {canManage && (e.status === "draft" || e.status === "rejected") && act("submit", "Submit for approval", { variant: "primary" })}
                      {canApprove && e.status === "submitted" && act("approve", "Approve", { variant: "primary" })}
                      {canApprove && e.status === "submitted" && act("reject", "Reject", { note: true })}
                      {canManage && e.status === "approved" && act("pay", "Mark paid", { variant: "primary", date: true })}
                      {canManage && e.status === "paid" && act("reimburse", "Mark reimbursed")}
                      {(e.status === "submitted" || e.status === "approved") && act("cancel", "Cancel", { note: true, variant: "danger" })}
                      {canManage && e.status === "draft" && act("delete", "Delete draft", { variant: "danger" })}
                      {canManage && projectFiles.length > 0 && (
                        <ActionForm action={expenseAction} submitLabel="Attach receipt" variant="quiet" className="flex items-center gap-2">
                          {hidden}
                          <input type="hidden" name="intent" value="attach" />
                          <input type="hidden" name="expenseId" value={e.id} />
                          <select name="fileId" className="input max-w-48 py-1 text-sm" aria-label="Receipt file">
                            {projectFiles.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                          </select>
                        </ActionForm>
                      )}
                    </div>
                  )}
                  {history.length > 0 && (
                    <details className="mt-2 text-xs text-graphite">
                      <summary className="cursor-pointer">History</summary>
                      <ul className="mt-1 grid gap-0.5">
                        {history.map(({ h, name }) => (
                          <li key={h.id}>
                            {formatDateTime(h.createdAt)} · {name ?? "—"}: {h.fromStatus} → {h.toStatus}
                            {h.selfApproved ? " (approved by the submitter)" : ""}
                            {h.note ? ` · “${h.note}”` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Funding">
        {funding.sources.length > 0 && (
          <div className="mb-6 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-graphite">
                <tr className="border-b border-rule">
                  <th className="py-2 pr-3 font-semibold">Source</th>
                  <th className="py-2 pr-3 text-right font-semibold">Awarded</th>
                  <th className="py-2 pr-3 text-right font-semibold">Received</th>
                  <th className="py-2 pr-3 text-right font-semibold">Outstanding</th>
                  <th className="py-2 text-right font-semibold">Committed + spent</th>
                </tr>
              </thead>
              <tbody className="ruled tabular-nums">
                {d.funding.map((f) => (
                  <tr key={f.source.id}>
                    <td className="py-1.5 pr-3">
                      {f.source.name} <span className="text-xs text-graphite">· {KIND_LABEL[f.source.kind]}{f.source.reference ? ` · ${f.source.reference}` : ""}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right">{f.source.awardedMinor ? formatMoney(f.source.awardedMinor, f.source.currency) : "—"}</td>
                    <td className="py-1.5 pr-3 text-right">{formatMoney(f.receivedOrig, f.source.currency)}</td>
                    <td className="py-1.5 pr-3 text-right">{f.source.awardedMinor ? formatMoney(f.outstandingOrig, f.source.currency) : "—"}</td>
                    <td className="py-1.5 text-right">{M(f.spentBase)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canManage && (
          <div className="grid gap-6 lg:grid-cols-2">
            <details open={funding.sources.length === 0}>
              <summary className="cursor-pointer font-semibold">Add a funding source</summary>
              <ActionForm action={fundingAction} submitLabel="Add source" resetOnSuccess className="mt-3 grid gap-3">
                {hidden}
                <input type="hidden" name="intent" value="source" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="fs-name" label="Name" name="name" required maxLength={200} />
                  <div className="field">
                    <label htmlFor="f-kind">Type</label>
                    <select id="f-kind" name="kind" className="input" defaultValue="grant">
                      {FUNDING_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                    </select>
                  </div>
                  <Field label="Funder" name="funderName" maxLength={200} />
                  <Field label="Grant or award reference" name="reference" maxLength={200} />
                  <Field label="Amount awarded" name="awarded" inputMode="decimal" hint="Leave empty for open-ended personal funding." />
                  <CurrencyInput name="currency" defaultValue={base} />
                  <Field id="fs-start" label="Start" name="startDate" type="date" />
                  <Field id="fs-end" label="End" name="endDate" type="date" />
                </div>
              </ActionForm>
            </details>
            {funding.sources.length > 0 && (
              <details>
                <summary className="cursor-pointer font-semibold">Record money received</summary>
                <ActionForm action={fundingAction} submitLabel="Record receipt" resetOnSuccess className="mt-3 grid gap-3">
                  {hidden}
                  <input type="hidden" name="intent" value="receipt" />
                  <div className="field">
                    <label htmlFor="r-src">Source</label>
                    <select id="r-src" name="fundingSourceId" className="input">
                      {funding.sources.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.currency})</option>)}
                    </select>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Date" name="receivedDate" type="date" defaultValue={v.today} required />
                    <Field id="r-amount" label="Amount" name="amount" inputMode="decimal" required hint="Negative to correct an entry." />
                    <Field id="r-fx" label="Exchange rate" name="fxRate" inputMode="decimal" />
                  </div>
                  <Field id="r-note" label="Note" name="note" maxLength={1000} />
                </ActionForm>
              </details>
            )}
          </div>
        )}
      </Section>

      <Section title="Exchange rates" description={`Rates are entered by you and stored with each transaction. Nothing is fetched or estimated automatically.`}>
        {rates.length > 0 && (
          <ul className="mb-4 grid max-w-xl gap-1 text-sm tabular-nums">
            {rates.slice(0, 10).map((r) => (
              <li key={r.id}>{formatDate(r.rateDate)}: 1 {r.fromCurrency} = {String(r.rate).replace(/\.?0+$/, "")} {r.toCurrency}</li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="max-w-2xl">
            <ActionForm action={fundingAction} submitLabel="Save rate" resetOnSuccess className="grid gap-3 sm:grid-cols-4">
              {hidden}
              <input type="hidden" name="intent" value="rate" />
              <CurrencyInput name="fromCurrency" label="1 unit of" defaultValue="USD" />
              <Field label="equals" name="rate" inputMode="decimal" required />
              <CurrencyInput name="toCurrency" label="of" defaultValue={base} />
              <Field label="on" name="rateDate" type="date" defaultValue={v.today} required />
            </ActionForm>
          </div>
        )}
      </Section>

      <Section title="Reports" description="Download for grant reporting or your institution.">
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {Object.entries(REPORTS).map(([key, label]) => (
            <li key={key} className="flex items-center justify-between gap-3 rounded-md border border-rule bg-sheet px-3 py-2">
              <span>{label}</span>
              <span className="flex gap-2">
                {(["pdf", "xlsx", "csv"] as const).map((f) => (
                  <a key={f} href={`/api/projects/${projectId}/finance/reports/${key}?format=${f}`} className="text-xs font-semibold" aria-label={`Download ${label} as ${f.toUpperCase()}`} download>{f.toUpperCase()}</a>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Settings and audit trail">
        {v.can("finance.manage") && !v.archived && (
          <div className="mb-6 flex flex-wrap items-end gap-6">
            <ActionForm action={financeSettingsAction} submitLabel="Save" variant="quiet" className="flex items-end gap-3">
              {hidden}
              <input type="hidden" name="enabled" value="true" />
              <Field label="Alert at (% of budget used)" name="alertThresholdPercent" type="number" min={1} max={100} defaultValue={s.settings.alertThresholdPercent} />
            </ActionForm>
            <ActionForm action={financeSettingsAction} submitLabel="Turn off financial tracking" variant="danger" className="flex">
              {hidden}
              <input type="hidden" name="enabled" value="false" />
            </ActionForm>
          </div>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-graphite">Recent financial activity ({audit.length})</summary>
          <ul className="ruled mt-2 max-w-3xl text-xs">
            {audit.map(({ a, name }) => (
              <li key={a.id} className="py-1">
                {formatDateTime(a.createdAt)} · {name ?? "—"} · {a.action.replace(/[._]/g, " ")}
              </li>
            ))}
          </ul>
        </details>
        <p className="mt-4 text-xs text-graphite">Project financial management only, not a replacement for statutory accounting. Statuses: {EXPENSE_STATUSES.join(", ")}.</p>
      </Section>
    </>
  );
}
