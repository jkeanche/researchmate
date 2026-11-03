export const REVIEW_STATUS: Record<string, [string, string]> = {
  submitted: ["Waiting for review", "awaiting_approval"],
  in_review: ["In review", "in_progress"],
  changes_requested: ["Changes requested", "blocked"],
  approved: ["Approved", "done"],
  withdrawn: ["Withdrawn", "skipped"],
};

export const TASK_STATUS: Record<string, [string, string]> = {
  open: ["Open", "todo"],
  reopened: ["Reopened", "blocked"],
  addressed: ["Addressed", "awaiting_approval"],
  declined: ["Declined (reason given)", "awaiting_approval"],
  verified: ["Verified", "done"],
};

export const SEVERITY: Record<string, [string, string]> = { minor: ["Minor", "todo"], major: ["Major", "awaiting_approval"], critical: ["Critical", "blocked"] };
