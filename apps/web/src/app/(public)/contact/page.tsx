import { CATEGORY_LABELS } from "@researchmate/admin";
import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { contactAction } from "@/server/actions/support";
import { getSession } from "@/server/session";

export const metadata = { title: "Contact us", description: "Questions about ResearchMate, plans for a department or institution, or help with your account." };
export const dynamic = "force-dynamic";

export default async function ContactPage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const [session, sp] = await Promise.all([getSession(), searchParams]);
  const topic = sp.topic && sp.topic in CATEGORY_LABELS ? sp.topic : "general";
  return (
    <>
      <h1 className="text-[2rem]">Contact us</h1>
      <p className="mt-2 mb-8 max-w-xl text-graphite">
        Questions about ResearchMate, plans for a department or institution, or a problem with your account. We reply by email.
        {session && <> You&rsquo;re signed in, so you can also follow your messages under <Link href="/app/help">Help</Link>.</>}
      </p>
      <ActionForm action={contactAction} submitLabel="Send message" pendingLabel="Sending…" className="grid gap-4 rounded-md border border-rule bg-sheet p-6" resetOnSuccess>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name" name="name" required autoComplete="name" maxLength={120} defaultValue={undefined} />
          <Field label="Email" name="email" type="email" required autoComplete="email" maxLength={254} defaultValue={session?.user.email} />
        </div>
        <div className="field">
          <label htmlFor="c-cat">Topic</label>
          <select id="c-cat" name="category" className="input" defaultValue={topic}>
            {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <Field label="Subject" name="subject" required minLength={3} maxLength={150} />
        <div className="field">
          <label htmlFor="c-body">Message</label>
          <textarea id="c-body" name="body" className="input min-h-40" required minLength={10} maxLength={10000} />
        </div>
        {/* Spam trap: hidden from people, filled in by bots. */}
        <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label htmlFor="c-website">Website</label>
          <input id="c-website" name="website" tabIndex={-1} autoComplete="off" />
        </div>
        <p className="text-xs text-graphite">We use your details only to answer this message. Please don&rsquo;t include passwords or confidential research data.</p>
      </ActionForm>
    </>
  );
}
