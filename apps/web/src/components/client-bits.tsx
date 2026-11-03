"use client";

import { useRouter } from "next/navigation";
import { useActionState, useRef, useState } from "react";
import type { FormState } from "@/server/form";
import { FormMessage } from "./action-form";

/** Organization switcher: submits as soon as a different organization is chosen. */
export function OrgSwitcher({
  current,
  organizations,
  action,
}: {
  current: string;
  organizations: { id: string; name: string; planName: string | null }[];
  action: (form: FormData) => Promise<void>;
}) {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form action={action} ref={ref}>
      <label htmlFor="org-switch" className="sr-only">Organization</label>
      <select
        id="org-switch"
        name="organizationId"
        defaultValue={current}
        className="input py-1.5 text-sm"
        onChange={() => ref.current?.requestSubmit()}
      >
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="btn btn-quiet mt-2">Switch</button>
      </noscript>
    </form>
  );
}

/**
 * Streams a file straight to the upload endpoint (no multipart buffering).
 * The browser sends Content-Length, which the server uses to reserve quota
 * before accepting any bytes.
 */
export function FileUploader({
  organizationId,
  projectId,
  accept,
  maxBytes,
  disabledReason,
}: {
  organizationId: string;
  projectId?: string;
  accept: string;
  maxBytes: number;
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<FormState>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  async function upload(file: File) {
    if (file.size > maxBytes) {
      setState({ error: `“${file.name}” is ${(file.size / 1048576).toFixed(1)} MB. Your plan allows files up to ${(maxBytes / 1048576).toFixed(0)} MB.` });
      return;
    }
    setBusy(true);
    setState({});
    setProgress(0);
    const params = new URLSearchParams({ organizationId, name: file.name });
    if (projectId) params.set("projectId", projectId);
    // XMLHttpRequest gives upload progress, which fetch does not.
    const result = await new Promise<FormState>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/files?${params.toString()}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText || "{}");
          resolve(xhr.status < 300 ? { success: `Uploaded “${body.file?.originalName ?? file.name}”.` } : { error: body.error ?? "Upload failed." });
        } catch {
          resolve({ error: "Upload failed." });
        }
      };
      xhr.onerror = () => resolve({ error: "The upload was interrupted. Check your connection and try again." });
      xhr.send(file);
    });
    setBusy(false);
    setProgress(null);
    setState(result);
    if (input.current) input.current.value = "";
    if (result.success) router.refresh();
  }

  if (disabledReason) {
    return <p className="rounded-md border border-amber/30 bg-amber-wash px-3 py-2 text-sm text-amber">{disabledReason}</p>;
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className={`btn btn-quiet ${busy ? "pointer-events-none opacity-60" : ""}`}>
          <input
            ref={input}
            type="file"
            accept={accept}
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          {busy ? "Uploading…" : "Upload a file"}
        </label>
        <span className="text-sm text-graphite">PDF, Word, Excel, PowerPoint, CSV, text, BibTeX, RIS or images, up to {(maxBytes / 1048576).toFixed(0)} MB.</span>
      </div>
      {progress !== null && (
        <div className="h-1.5 w-full max-w-sm overflow-hidden rounded bg-rule-soft" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
          <div className="h-full bg-green" style={{ width: `${progress}%` }} />
        </div>
      )}
      <FormMessage state={state} />
    </div>
  );
}

/** A destructive button that asks for confirmation first. */
export function ConfirmAction({
  action,
  fields,
  label,
  confirmText,
  variant = "danger",
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  fields: Record<string, string>;
  label: string;
  confirmText: string;
  variant?: "danger" | "quiet";
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm(confirmText)) e.preventDefault();
      }}
      className="inline-grid gap-2"
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" className={`btn btn-${variant} px-3 py-1.5 text-sm`} disabled={pending}>
        {pending ? "Working…" : label}
      </button>
      {state.error && <span role="alert" className="text-sm text-margin">{state.error}</span>}
    </form>
  );
}

export function PrintButton() {
  return (
    <button type="button" className="btn btn-quiet" onClick={() => window.print()}>
      Print or save as PDF
    </button>
  );
}
