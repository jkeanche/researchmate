/**
 * Notification kinds (§30). `locked` kinds are security notices: their email
 * can't be turned off, so a compromised session can't silence the warning.
 */
export const NOTIFICATION_KINDS = {
  "task.due_soon": { group: "Deadlines", label: "A task of mine is due within two days", inApp: true, email: true },
  "task.overdue": { group: "Deadlines", label: "A task of mine is overdue", inApp: true, email: true },
  "milestone.due_soon": { group: "Deadlines", label: "A project milestone is due within a week", inApp: true, email: false },
  "workflow.stage_completed": { group: "Projects", label: "A workflow stage is completed", inApp: true, email: false },
  "review.requested": { group: "Supervision", label: "A document is submitted for my review", inApp: true, email: true },
  "review.decided": { group: "Supervision", label: "A supervisor approves or requests changes", inApp: true, email: true },
  "document.export_ready": { group: "Documents", label: "A document export is ready or failed", inApp: true, email: false },
  "storage.limit": { group: "Account limits", label: "Storage is nearly full", inApp: true, email: true },
  "ai.budget": { group: "Account limits", label: "AI allowance or credit is running low", inApp: true, email: true },
  "finance.budget_threshold": { group: "Project finances", label: "Project spending passes 80% or 100% of the budget", inApp: true, email: true },
  "finance.expense_pending": { group: "Project finances", label: "An expense is waiting for my approval", inApp: true, email: true },
  "finance.funding": { group: "Project finances", label: "Funding is added or changes", inApp: true, email: false },
  "billing.subscription": { group: "Billing", label: "Subscription changes", inApp: true, email: true },
  "billing.payment_failed": { group: "Billing", label: "A payment fails", inApp: true, email: true },
  "drive.reauth": { group: "Integrations", label: "Google Drive needs to be reconnected", inApp: true, email: true },
  "support.enquiry": { group: "Administration", label: "A new enquiry or a reply arrives (platform administrators)", inApp: true, email: true },
  "support.reply": { group: "Support", label: "Our team replies to my enquiry", inApp: true, email: true },
  "security.alert": { group: "Security", label: "Security changes to my account (always emailed)", inApp: true, email: true, locked: true },
} as const satisfies Record<string, { group: string; label: string; inApp: boolean; email: boolean; locked?: boolean }>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;
