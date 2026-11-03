"use client";

import { startTransition, useActionState, type ReactNode } from "react";
import type { FormState } from "@/server/form";

type Action = (state: FormState, form: FormData) => Promise<FormState>;

/**
 * Progressive-enhancement form bound to a server action. Shows the action's
 * error or success message and disables the submit button while pending.
 * `children` may be a render function to show data the action returned.
 */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  children,
  className = "grid gap-4",
  variant = "primary",
  resetOnSuccess = false,
}: {
  action: Action;
  submitLabel: string;
  pendingLabel?: string;
  children?: ReactNode | ((state: FormState) => ReactNode);
  className?: string;
  variant?: "primary" | "quiet" | "danger";
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      // Submitting manually keeps typed values after an error (React resets
      // uncontrolled forms after a form action). Without JS, `action` still works.
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
      className={className}
      key={resetOnSuccess && state.success ? state.success : undefined}
    >
      {typeof children === "function" ? children(state) : children}
      <FormMessage state={state} />
      <div>
        <button type="submit" className={`btn btn-${variant}`} disabled={pending}>
          {pending ? pendingLabel ?? "Working…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

export function FormMessage({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-md border border-margin/30 bg-margin-wash px-3 py-2 text-sm text-margin">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p role="status" className="rounded-md border border-green/30 bg-green-wash px-3 py-2 text-sm text-green-dark">
        {state.success}
      </p>
    );
  }
  return null;
}

export function Field({
  label,
  name,
  type = "text",
  hint,
  defaultValue,
  required,
  autoComplete,
  id: idProp,
  ...rest
}: {
  label: string;
  name: string;
  id?: string;
  type?: string;
  hint?: string;
  defaultValue?: string | number | null;
  required?: boolean;
  autoComplete?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "defaultValue">) {
  const id = idProp ?? `f-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type={type}
        className="input"
        defaultValue={defaultValue ?? undefined}
        required={required}
        autoComplete={autoComplete}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...rest}
      />
      {hint ? (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
