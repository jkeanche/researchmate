import { listActiveSessions } from "@researchmate/auth";
import { ActionForm, Field } from "@/components/action-form";
import { ConfirmAction } from "@/components/client-bits";
import { ReauthAction, TwoFactorEnroll } from "@/components/two-factor";
import { PageHeader, Section } from "@/components/ui";
import { describeUserAgent, formatDate, formatDateTime } from "@/lib/format";
import {
  beginTwoFactorAction,
  changePasswordAction,
  confirmTwoFactorAction,
  disableTwoFactorAction,
  regenerateRecoveryCodesAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
} from "@/server/actions/account";
import { authService, db } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Security" };

export default async function SecurityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const session = await requireSession();
  const [tfa, sessions] = await Promise.all([authService().getTwoFactorStatus(session.user.id), listActiveSessions(db(), session.user.id)]);

  return (
    <>
      <PageHeader title="Security" description="Your password, two-factor authentication and signed-in devices." />

      {sp.recovery === "used" && (
        <p role="status" className="mb-8 rounded-md border border-amber/30 bg-amber-wash px-4 py-3 text-sm text-amber">
          You signed in with a recovery code. You have {tfa.recoveryCodesRemaining} left. If your authenticator app is lost, create new codes below.
        </p>
      )}

      <Section title="Two-factor authentication" description="A code from your phone in addition to your password when you sign in.">
        {tfa.enabled ? (
          <div className="grid gap-8">
            <p className="text-sm">
              <span className="font-semibold text-green-dark">On</span> since {formatDate(tfa.enabledAt)}. {tfa.recoveryCodesRemaining} of 10 recovery codes unused.
            </p>
            <div>
              <h3 className="mb-2 text-base">Create new recovery codes</h3>
              <ReauthAction action={regenerateRecoveryCodesAction} submitLabel="Create new codes" />
            </div>
            <div>
              <h3 className="mb-2 text-base">Turn off two-factor authentication</h3>
              <p className="mb-3 text-sm text-graphite">Your other sessions will be signed out.</p>
              <ReauthAction action={disableTwoFactorAction} submitLabel="Turn off" variant="danger" />
            </div>
          </div>
        ) : (
          <TwoFactorEnroll begin={beginTwoFactorAction} confirm={confirmTwoFactorAction} />
        )}
      </Section>

      <Section title="Password">
        <div className="max-w-md">
          <ActionForm action={changePasswordAction} submitLabel="Change password" pendingLabel="Saving…" resetOnSuccess>
            <Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" required />
            <Field label="New password" name="newPassword" type="password" autoComplete="new-password" required minLength={10} hint="At least 10 characters. Other sessions will be signed out." />
            <Field label="Confirm new password" name="confirmPassword" type="password" autoComplete="new-password" required minLength={10} />
          </ActionForm>
        </div>
      </Section>

      <Section
        title="Signed-in devices"
        aside={sessions.length > 1 ? <ConfirmAction action={revokeOtherSessionsAction} fields={{}} label="Sign out all other devices" variant="quiet" confirmText="Sign out every other device?" /> : null}
      >
        <ul className="ruled">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div>
                <p className="font-medium">
                  {describeUserAgent(s.userAgent)}
                  {s.id === session.sessionId && <span className="ml-2 rounded border border-green/40 px-1.5 py-0.5 text-xs text-green-dark">This device</span>}
                </p>
                <p className="text-graphite">
                  {s.ipAddress ?? "Unknown address"}, last active {formatDateTime(s.lastSeenAt)}, signed in {formatDate(s.createdAt)}
                  {s.twoFactorVerified ? ", verified with 2FA" : ""}
                </p>
              </div>
              {s.id !== session.sessionId && <ConfirmAction action={revokeSessionAction} fields={{ sessionId: s.id }} label="Sign out" variant="quiet" confirmText="Sign out this device?" />}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
