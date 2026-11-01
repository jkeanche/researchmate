"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/server/form";
import { FormMessage } from "./action-form";

type Action = (state: FormState, form: FormData) => Promise<FormState>;

function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-rule bg-paper p-4">
      <p className="font-semibold">Save these recovery codes now</p>
      <p className="mt-1 text-sm text-graphite">
        Each code works once if you lose access to your authenticator app. They won't be shown again. Store them in a password manager or print them.
      </p>
      <ol className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[0.95rem] tabular-nums sm:grid-cols-2">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="btn btn-quiet px-3 py-1.5 text-sm"
          onClick={async () => {
            await navigator.clipboard.writeText(codes.join("\n"));
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy codes"}
        </button>
        <a
          className="btn btn-quiet px-3 py-1.5 text-sm"
          download="researchmate-recovery-codes.txt"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(`ResearchMate recovery codes\n\n${codes.join("\n")}\n`)}`}
        >
          Download
        </a>
      </div>
    </div>
  );
}

/** Enrollment: generate secret → scan QR → confirm code → show recovery codes once. */
export function TwoFactorEnroll({ begin, confirm }: { begin: Action; confirm: Action }) {
  const [started, beginAction, beginning] = useActionState(begin, {});
  const [confirmed, confirmAction, confirming] = useActionState(confirm, {});
  const codes = confirmed.data?.recoveryCodes as string[] | undefined;

  if (codes) {
    return (
      <div className="grid gap-4">
        <FormMessage state={confirmed} />
        <RecoveryCodes codes={codes} />
        <a href="/app/settings/security" className="btn btn-primary w-fit">I've saved my codes</a>
      </div>
    );
  }

  const secret = started.data?.secret as string | undefined;
  const qr = started.data?.qr as string | undefined;
  if (!secret) {
    return (
      <form action={beginAction} className="grid gap-3">
        <p className="text-sm text-graphite">You'll need an authenticator app such as Google Authenticator, Microsoft Authenticator, 1Password or Aegis.</p>
        <FormMessage state={started} />
        <div>
          <button className="btn btn-primary" disabled={beginning}>{beginning ? "Preparing…" : "Set up two-factor authentication"}</button>
        </div>
      </form>
    );
  }

  return (
    <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-start">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qr} alt="QR code to add ResearchMate to your authenticator app" width={180} height={180} className="rounded border border-rule bg-white p-2" />
      <div className="grid gap-4">
        <div className="text-sm">
          <p>Scan the QR code with your authenticator app. If you can't scan it, enter this key manually:</p>
          <p className="mt-2 rounded bg-paper px-2 py-1.5 font-mono break-all select-all">{secret.match(/.{1,4}/g)?.join(" ")}</p>
        </div>
        <form action={confirmAction} className="grid gap-3">
          <div className="field">
            <label htmlFor="enroll-code">6-digit code from the app</label>
            <input id="enroll-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required className="input max-w-40 font-mono tracking-widest" />
          </div>
          <FormMessage state={confirmed} />
          <div>
            <button className="btn btn-primary" disabled={confirming}>{confirming ? "Checking…" : "Turn on two-factor authentication"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Password + code form used to disable 2FA or regenerate recovery codes. */
export function ReauthAction({ action, submitLabel, variant = "quiet" }: { action: Action; submitLabel: string; variant?: "quiet" | "danger" }) {
  const [state, formAction, pending] = useActionState(action, {});
  const codes = state.data?.recoveryCodes as string[] | undefined;
  return (
    <div className="grid gap-4">
      <form action={formAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="field">
          <label htmlFor={`${submitLabel}-pw`}>Password</label>
          <input id={`${submitLabel}-pw`} name="password" type="password" autoComplete="current-password" required className="input" />
        </div>
        <div className="field">
          <label htmlFor={`${submitLabel}-code`}>Authentication or recovery code</label>
          <input id={`${submitLabel}-code`} name="code" autoComplete="one-time-code" required className="input font-mono" maxLength={16} />
        </div>
        <button className={`btn btn-${variant}`} disabled={pending}>{pending ? "Working…" : submitLabel}</button>
      </form>
      <FormMessage state={state} />
      {codes && <RecoveryCodes codes={codes} />}
    </div>
  );
}
