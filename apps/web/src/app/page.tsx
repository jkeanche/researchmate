import { planEntitlements, plans } from "@researchmate/database";
import { formatBytes } from "@researchmate/entitlements";
import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { db } from "@/server/services";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

const STAGES = [
  ["Topic and research questions", "Shape a researchable question and objectives that line up with it."],
  ["Literature and evidence", "Keep every source, quotation and claim linked to where it came from."],
  ["Methodology and plan", "Schedule the work, set milestones and, if you have one, track the budget."],
  ["Data and analysis", "Run analyses with real tools on your real data, and keep the scripts."],
  ["Writing and citations", "Draft chapters against your institution's template and audit every reference."],
  ["Supervisor review and submission", "Share drafts, turn feedback into revision tasks, submit with confidence."],
] as const;

async function loadPlans() {
  const rows = await db().select().from(plans).where(eq(plans.isPublic, true)).orderBy(asc(plans.sortOrder));
  const ents = await db().select().from(planEntitlements);
  return rows
    .filter((p) => p.isActive)
    .map((p) => {
      const v = Object.fromEntries(ents.filter((e) => e.planId === p.id).map((e) => [e.featureKey, e.value]));
      return { ...p, v };
    });
}

function count(v: unknown, noun: string) {
  if (v === null) return `Unlimited ${noun}s`;
  const n = Number(v);
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

export default async function Home() {
  const [session, planList] = await Promise.all([getSession(), loadPlans()]);
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Wordmark />
        <nav className="flex items-center gap-2 text-sm">
          <a href="#pricing" className="hidden px-3 py-2 sm:inline">Pricing</a>
          <Link href="/contact" className="hidden px-3 py-2 sm:inline">Contact</Link>
          {session ? (
            <Link href="/app" className="btn btn-primary">Open workspace</Link>
          ) : (
            <>
              <Link href="/login" className="px-3 py-2">Sign in</Link>
              <Link href="/register" className="btn btn-primary">Create account</Link>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl gap-12 px-5 pt-10 pb-20 lg:grid-cols-[1.05fr_1fr] lg:items-start lg:pt-16">
          <div className="max-w-xl">
            <h1 className="text-[2.6rem] leading-[1.08] sm:text-[3.4rem]">Your thesis, planned, sourced and written in one place.</h1>
            <p className="mt-6 text-lg text-graphite">
              ResearchMate keeps your research questions, sources, evidence, schedule and drafts together, so you always know what's next and where every claim came from.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/register" className="btn btn-primary">Start free</Link>
              <a href="#how" className="btn btn-quiet">See how it works</a>
            </div>
            <p className="mt-8 max-w-md border-l-2 border-green pl-4 text-sm text-graphite">
              AI helps you search, organise and draft. It never invents sources, citations or findings, and you stay responsible for what you submit.
            </p>
          </div>

          <figure id="how" className="margin-rule rounded-md border border-rule bg-sheet py-6 pr-6 pl-10 shadow-[0_1px_0_#cad6e2]" aria-label="The research lifecycle">
            <figcaption className="mb-4 font-serif text-lg">From first idea to final submission</figcaption>
            <ol className="ruled">
              {STAGES.map(([title, body], i) => (
                <li key={title} className="grid grid-cols-[2rem_1fr] gap-x-3 py-3">
                  <span className="font-serif text-lg text-graphite tabular-nums">{i + 1}</span>
                  <div>
                    <p className="font-semibold">{title}</p>
                    <p className="text-sm text-graphite">{body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </figure>
        </section>

        <section id="pricing" className="border-t border-rule bg-sheet">
          <div className="mx-auto max-w-6xl px-5 py-16">
            <h2 className="text-3xl">Plans</h2>
            <p className="mt-2 max-w-2xl text-graphite">Start on Free to look around. Upgrade when you need AI assistance, more storage or a team.</p>
            <div className="mt-10 overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-rule align-bottom">
                    <th className="py-3 pr-4 font-normal text-graphite" scope="col">
                      <span className="sr-only">Feature</span>
                    </th>
                    {planList.map((p) => (
                      <th key={p.id} scope="col" className="py-3 pr-4">
                        <span className="block font-serif text-lg">{p.name}</span>
                        <span className="text-2xl font-semibold tabular-nums">
                          {p.priceMinor === 0 ? "$0" : `$${(p.priceMinor / 100).toFixed(0)}`}
                        </span>
                        <span className="text-graphite"> / month</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="[&_tr]:border-b [&_tr]:border-rule-soft">
                  <PlanRow label="Projects" plans={planList} render={(v) => count(v["projects.max"], "project")} />
                  <PlanRow label="Files" plans={planList} render={(v) => count(v["files.max"], "file")} />
                  <PlanRow label="Storage" plans={planList} render={(v) => (v["storage.max_bytes"] === null ? "Unlimited" : formatBytes(Number(v["storage.max_bytes"])))} />
                  <PlanRow label="Largest file" plans={planList} render={(v) => formatBytes(Number(v["files.max_size_bytes"]))} />
                  <PlanRow label="AI assistance" plans={planList} render={(v) => tierLabel(v["ai.agents"])} />
                  <PlanRow label="Project planning" plans={planList} render={(v) => (v["planning.gantt"] === "overview" ? "Task list and timeline" : v["planning.gantt"] === "full" ? "Gantt, dependencies, baselines" : tierLabel(v["planning.gantt"]))} />
                  <PlanRow label="Tasks per project" plans={planList} render={(v) => count(v["planning.tasks.max"], "task")} />
                  <PlanRow label="Budget tracking" plans={planList} render={(v) => (v["finance.budget"] ? "Included" : "—")} />
                  <PlanRow label="Supervisor collaboration" plans={planList} render={(v) => tierLabel(v["collaboration.supervisor"])} />
                  <PlanRow label="Team members" plans={planList} render={(v) => count(v["members.max"], "member")} />
                </tbody>
              </table>
            </div>
            <p className="mt-6 text-sm text-graphite">Pay by card or mobile money from Settings → Billing. Need a plan for a department or institution? <Link href="/contact?topic=sales">Contact us</Link>.</p>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-sm text-graphite">
        <Wordmark />
        <p>Built for researchers. You own your work. · <Link href="/contact">Contact us</Link></p>
      </footer>
    </div>
  );
}

function tierLabel(v: unknown) {
  return ({ none: "—", limited: "Limited", basic: "Basic", full: "Full", advanced: "Advanced", overview: "Overview" } as Record<string, string>)[String(v)] ?? "—";
}

function PlanRow({ label, plans, render }: { label: string; plans: { id: string; v: Record<string, unknown> }[]; render: (v: Record<string, unknown>) => string }) {
  return (
    <tr>
      <th scope="row" className="py-3 pr-4 font-normal text-graphite">{label}</th>
      {plans.map((p) => (
        <td key={p.id} className="py-3 pr-4">{render(p.v)}</td>
      ))}
    </tr>
  );
}
