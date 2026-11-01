/**
 * Outbound email abstraction. The web app enqueues messages; the worker
 * delivers them over SMTP with retries. Tests use CapturingMailer.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export class CapturingMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
  }
  last(to?: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((m) => !to || m.to === to);
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(title: string, bodyHtml: string) {
  return `<!doctype html><html><body style="font-family:Georgia,serif;background:#f6f4ef;padding:24px;color:#1f2a2e">
<div style="max-width:520px;margin:auto;background:#fff;border:1px solid #e3ded3;border-radius:8px;padding:28px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${bodyHtml}
<p style="font-size:12px;color:#6b7377;margin-top:28px">ResearchMate AI</p></div></body></html>`;
}

export const emailTemplates = {
  verifyEmail(appUrl: string, token: string): Omit<EmailMessage, "to"> {
    const link = `${appUrl}/verify-email?token=${encodeURIComponent(token)}`;
    return {
      subject: "Verify your ResearchMate email",
      text: `Welcome to ResearchMate AI.\n\nConfirm your email address by opening this link (valid for 24 hours):\n${link}\n\nIf you didn't create an account, you can ignore this message.`,
      html: layout(
        "Verify your email",
        `<p>Confirm your email address to finish setting up your account. The link is valid for 24 hours.</p><p><a href="${escapeHtml(link)}" style="background:#1f4e5f;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Verify email</a></p><p style="font-size:13px;color:#6b7377">If you didn't create an account, ignore this message.</p>`,
      ),
    };
  },
  passwordReset(appUrl: string, token: string): Omit<EmailMessage, "to"> {
    const link = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    return {
      subject: "Reset your ResearchMate password",
      text: `Someone requested a password reset for your account.\n\nReset it here (valid for 1 hour):\n${link}\n\nIf this wasn't you, ignore this email; your password is unchanged.`,
      html: layout(
        "Reset your password",
        `<p>Someone requested a password reset for your account. The link is valid for 1 hour.</p><p><a href="${escapeHtml(link)}" style="background:#1f4e5f;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Choose a new password</a></p><p style="font-size:13px;color:#6b7377">If this wasn't you, ignore this email; your password is unchanged.</p>`,
      ),
    };
  },
  accountExists(appUrl: string): Omit<EmailMessage, "to"> {
    return {
      subject: "Sign-up attempt on your ResearchMate account",
      text: `Someone tried to create a ResearchMate account with this email address, which already has an account.\n\nIf it was you, sign in at ${appUrl}/login or reset your password at ${appUrl}/forgot-password.`,
      html: layout(
        "You already have an account",
        `<p>Someone tried to register with this email, which already has an account.</p><p>If it was you, <a href="${escapeHtml(appUrl)}/login">sign in</a> or <a href="${escapeHtml(appUrl)}/forgot-password">reset your password</a>.</p>`,
      ),
    };
  },
  securityNotice(title: string, detail: string): Omit<EmailMessage, "to"> {
    return {
      subject: `Security notice: ${title}`,
      text: `${detail}\n\nIf this wasn't you, reset your password immediately and review your active sessions.`,
      html: layout(title, `<p>${escapeHtml(detail)}</p><p style="font-size:13px;color:#6b7377">If this wasn't you, reset your password immediately and review your active sessions.</p>`),
    };
  },
};
