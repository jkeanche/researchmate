# Milestone 7 report: supervisor collaboration

Date: 2 November 2026 · Blueprint phase 12

## What was built

**Invitations by email** (Team tab).
- The project lead invites a supervisor (primary, co-supervisor or examiner) or a collaborator (researcher, research assistant or viewer) by email, with an optional message.
- The person doesn't need an account yet. The link leads to an invitation page, then sign-in or a registration form with the email filled in. After verifying their email, the invitation also appears on their dashboard to accept or decline.
- **Security:**
  - only an HMAC of the token is stored;
  - an invitation can be accepted only by an account whose verified email is the invited address;
  - it can be used once and expires after 14 days;
  - resending issues a new link and invalidates the old one; withdrawn links are refused.
- Accepting adds the person to the organization as `org_member` (they see only projects they're added to), subject to the plan's member limit, and to the project in the invited role. An invitation can never demote a project lead.
- Pending invitations are listed with resend and withdraw.

**Supervisors.** Active supervisor assignments, kept as a history (ending a supervision doesn't delete it). Supervisors can read the project and its documents, comment, review submissions and verify revisions. They cannot edit research, documents, plans or finances; every project tab was checked as a supervisor.

**Document submissions and review decisions** (Reviews tab).
- The researcher submits a document. A snapshot version is taken (optionally with a PDF rendered from it), so continued editing never changes what the supervisor sees.
- A submission can go to one named supervisor or any of them, with a message and a requested date. Supervisors are emailed.
- States: submitted → in review → changes requested / approved, or withdrawn. Each resubmission is a new round linked to the previous one.
- **Approval rules:**
  - Only a person with the review permission can decide, and only the assigned reviewer when one is named.
  - **Never the submitter.** This is enforced in the service and by a database check (`review_requests_not_self_check`), so a lead who also holds review rights can't approve their own work.
  - Requesting changes needs written feedback.
  - Decisions are emailed to the researcher and set the document's status: approved → final, changes requested → draft.
- Supervisors have a "Waiting for your review" list on their dashboard, across projects.

**Feedback.**
- Each supervisor gives an overall summary plus formal comments anchored to a section of the submitted version, with an optional quoted passage and an importance level (minor, major, critical).
- A comment can become a revision task in one step.
- Informal section comments on the document itself (milestone 6) remain available to everyone who can comment.

**Revision tasks.**
- Created from comments, by hand, or from accepted AI suggestions.
- The researcher answers each one ("addressed", or "won't change" with a reason that is required). Only a supervisor verifies or reopens it.
- Each response is appended, so the full exchange stays readable.

**Time measures**, tracked separately as §7 asks: supervisor waiting time (submission to decision), average turnaround, the longest open wait, revision time (changes requested to resubmission), and open revision tasks. These are shown on the Reviews tab.

**Supervisor Feedback Agent (AI).** It turns a supervisor's feedback into suggested revision tasks.
- It only suggests; the researcher accepts each one, and nothing changes otherwise. Section keys are checked against the submitted version, and comment links are resolved to real comments.
- Its instructions forbid speaking for the supervisor or implying approval. It has no access to decisions.
- It requires the supervisor-collaboration entitlement.

**Plans.** Free: no supervisor collaboration. Starter (limited): one supervisor per project, counting pending invitations, and no collaborator invitations. Pro and Team: unlimited supervisors; collaborator invitations follow `collaboration.team`.

## Found and fixed

- **An intermittent PDF export failure from milestone 6** (about 1 in 5 test runs). `soffice` forks `soffice.bin`, which was still writing to the throwaway profile when cleanup removed it. The resulting `ENOTEMPTY` replaced a successful conversion's result. LibreOffice now runs in its own process group, which is killed and awaited, and cleanup is retried and can't fail a conversion. Verified with 25 back-to-back conversions (no failures, no stray processes) and 8 repeated test runs.
- Answering a reopened revision task overwrote the supervisor's reopen note; responses now accumulate.
- E2E selector fixes in my tests: duplicate "Section" labels, and a success message that unmounts with its form.

## Data

Migration `0006_collaboration`: `invitations` (one open invitation per person and project), `supervisor_assignments`, `review_requests` (with decision and no-self-approval checks), `supervisor_feedback`, `supervisor_feedback_comments`, `revision_tasks`. The `ai_suggestions` kinds gain `revision_task`.

## Tests

- `tests/collaboration.test.ts` (6 tests):
  - token hashing and the invitation email;
  - wrong-account, reuse, resend, withdraw and expiry;
  - dashboard acceptance;
  - plan gating (Free, Starter's one-supervisor limit, collaborator invitations);
  - a full review round trip: no-self-approval in the service and in the database, section anchors, feedback required for changes, respond/verify permissions, resubmission rounds, waiting and revision time;
  - assigned-reviewer restriction, finance roles and outsiders refused;
  - the AI agent suggesting only, with invalid section keys dropped and an accepted suggestion creating the task.
- E2E `supervision.spec.ts`, with two people in separate browsers: invite by email → supervisor registers from the link → accepts on the dashboard → lead submits → supervisor comments and requests changes → lead answers → supervisor verifies. The lead never sees approve or verify controls.

**Totals:** 164 unit/integration tests and 9 E2E tests passing; typecheck clean; production build succeeds.
