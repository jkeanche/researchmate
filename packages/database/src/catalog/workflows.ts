/**
 * System workflow templates (seed data).
 *
 * A template is an ordered set of stages with nominal durations and
 * dependencies. Projects copy the stages when a template is applied, so later
 * template edits never change an existing project. Durations are calendar
 * days for a "typical" project and are scaled to fit the project's own start
 * and submission dates when a schedule is proposed.
 *
 * Templates are identified by (key, version). Changing a template's content
 * means adding a new version; existing versions are never edited in place.
 */

export type DependencyType = "FS" | "SS" | "FF" | "SF";

export interface StageSeed {
  key: string;
  name: string;
  purpose: string;
  expectedOutputs: string;
  completionCriteria: string;
  durationDays: number;
  /** Predecessor stage keys. Default type FS, lag 0. */
  dependsOn?: (string | { key: string; type: DependencyType; lagDays?: number })[];
  approvalRequired?: boolean;
  optional?: boolean;
  /** Adds a milestone at the end of this stage in proposed schedules. */
  milestone?: string;
}

export interface WorkflowTemplateSeed {
  key: string;
  version: number;
  name: string;
  description: string;
  /** Research types this template is the default for. */
  defaultFor: string[];
  stages: StageSeed[];
}

const seq = (stages: Omit<StageSeed, "dependsOn">[], extra: Record<string, StageSeed["dependsOn"]> = {}): StageSeed[] =>
  stages.map((s, i) => ({ ...s, dependsOn: extra[s.key] ?? (i === 0 ? [] : [stages[i - 1]!.key]) }));

export const WORKFLOW_TEMPLATE_SEEDS: WorkflowTemplateSeed[] = [
  {
    key: "thesis_full",
    version: 1,
    name: "Thesis or dissertation (full lifecycle)",
    description: "From topic selection to final submission, with proposal and supervisor review gates.",
    defaultFor: ["undergraduate_project", "masters_thesis", "phd_dissertation", "institutional_research", "independent_research", "custom"],
    stages: seq(
      [
        { key: "setup", name: "Project setup", purpose: "Record requirements, deadlines and supervision arrangements.", expectedOutputs: "Project details, document specification, supervisor recorded.", completionCriteria: "Project requirements confirmed.", durationDays: 5 },
        { key: "topic_selection", name: "Topic selection", purpose: "Choose a researchable topic of interest.", expectedOutputs: "Shortlist of candidate topics.", completionCriteria: "One topic chosen.", durationDays: 10 },
        { key: "topic_refinement", name: "Topic refinement", purpose: "Narrow the topic to a feasible scope.", expectedOutputs: "Refined working title and scope statement.", completionCriteria: "Scope agreed with supervisor.", durationDays: 7, approvalRequired: true },
        { key: "problem", name: "Research problem", purpose: "State the problem the research addresses.", expectedOutputs: "Problem statement.", completionCriteria: "Problem statement drafted and reviewed.", durationDays: 7 },
        { key: "questions", name: "Research questions", purpose: "Formulate the main and specific research questions.", expectedOutputs: "Research questions and hypotheses where applicable.", completionCriteria: "Questions recorded in the project.", durationDays: 7 },
        { key: "objectives", name: "Research objectives", purpose: "Define objectives aligned with the questions.", expectedOutputs: "General and specific objectives.", completionCriteria: "Every objective maps to a question.", durationDays: 5 },
        { key: "lit_discovery", name: "Literature discovery", purpose: "Find relevant prior work.", expectedOutputs: "Reference library and reading list.", completionCriteria: "Core sources identified.", durationDays: 21 },
        { key: "lit_review", name: "Literature review", purpose: "Synthesise prior work thematically.", expectedOutputs: "Literature review draft.", completionCriteria: "Draft complete.", durationDays: 30 },
        { key: "gap", name: "Research gap", purpose: "Identify what prior work leaves open.", expectedOutputs: "Gap statement linked to evidence.", completionCriteria: "Gap justified by sources.", durationDays: 7 },
        { key: "methodology", name: "Methodology", purpose: "Design the study: approach, sampling, instruments, analysis.", expectedOutputs: "Methodology chapter draft.", completionCriteria: "Design reviewed.", durationDays: 21 },
        { key: "proposal", name: "Proposal", purpose: "Assemble and defend the research proposal.", expectedOutputs: "Proposal document.", completionCriteria: "Proposal approved.", durationDays: 14, approvalRequired: true, milestone: "Proposal approved" },
        { key: "data_collection", name: "Data collection", purpose: "Collect data according to the approved design and ethics approval.", expectedOutputs: "Raw dataset and collection log.", completionCriteria: "Target sample reached.", durationDays: 45 },
        { key: "analysis", name: "Data analysis", purpose: "Clean and analyse the data reproducibly.", expectedOutputs: "Analysis scripts, outputs and notes.", completionCriteria: "Analysis complete for every objective.", durationDays: 30 },
        { key: "results", name: "Results", purpose: "Report findings.", expectedOutputs: "Results chapter draft.", completionCriteria: "Draft complete.", durationDays: 14 },
        { key: "discussion", name: "Discussion", purpose: "Interpret findings against the literature.", expectedOutputs: "Discussion chapter draft.", completionCriteria: "Draft complete.", durationDays: 14 },
        { key: "conclusion", name: "Conclusion", purpose: "Summarise contributions, limitations and recommendations.", expectedOutputs: "Conclusion chapter draft.", completionCriteria: "Draft complete.", durationDays: 7 },
        { key: "final_document", name: "Final document", purpose: "Assemble the complete document.", expectedOutputs: "Full draft in the required format.", completionCriteria: "All sections present.", durationDays: 10 },
        { key: "audit", name: "Citation and formatting audit", purpose: "Check references, citations and formatting.", expectedOutputs: "Audit report with issues resolved.", completionCriteria: "No outstanding audit issues.", durationDays: 5 },
        { key: "supervisor_review", name: "Supervisor review", purpose: "Address supervisor feedback on the full draft.", expectedOutputs: "Revised document.", completionCriteria: "Supervisor approves submission.", durationDays: 14, approvalRequired: true },
        { key: "submission", name: "Final submission", purpose: "Submit to the institution.", expectedOutputs: "Submitted document and confirmation.", completionCriteria: "Submission confirmed.", durationDays: 2, milestone: "Thesis submitted" },
      ],
      {
        // Writing the review overlaps discovery; questions and objectives are drafted together.
        lit_review: [{ key: "lit_discovery", type: "SS", lagDays: 7 }],
        gap: [{ key: "lit_review", type: "FF" }],
        objectives: [{ key: "questions", type: "SS", lagDays: 2 }],
        lit_discovery: ["objectives"],
      },
    ),
  },
  {
    key: "article",
    version: 1,
    name: "Journal article or conference paper",
    description: "A shorter cycle for a single paper, from question to submission.",
    defaultFor: ["journal_article", "conference_paper", "scientific_paper"],
    stages: seq([
      { key: "setup", name: "Project setup", purpose: "Record the target venue, its requirements and deadline.", expectedOutputs: "Venue, word limit, citation style.", completionCriteria: "Requirements recorded.", durationDays: 2 },
      { key: "questions", name: "Research questions", purpose: "State the question and contribution.", expectedOutputs: "Research question and contribution statement.", completionCriteria: "Agreed by co-authors.", durationDays: 5 },
      { key: "lit_review", name: "Literature review", purpose: "Position the work against prior research.", expectedOutputs: "Related-work section draft.", completionCriteria: "Draft complete.", durationDays: 14 },
      { key: "methodology", name: "Methods", purpose: "Describe and finalise the method.", expectedOutputs: "Methods section draft.", completionCriteria: "Draft complete.", durationDays: 10 },
      { key: "analysis", name: "Analysis and results", purpose: "Run analyses and report results.", expectedOutputs: "Results section with tables and figures.", completionCriteria: "Results final.", durationDays: 21 },
      { key: "drafting", name: "Full draft", purpose: "Write introduction, discussion and conclusion.", expectedOutputs: "Complete manuscript.", completionCriteria: "All sections drafted.", durationDays: 14 },
      { key: "audit", name: "Citation and formatting audit", purpose: "Match the venue's style and check references.", expectedOutputs: "Formatted manuscript.", completionCriteria: "Venue checklist satisfied.", durationDays: 3 },
      { key: "internal_review", name: "Internal review", purpose: "Co-author or supervisor review before submission.", expectedOutputs: "Reviewed manuscript.", completionCriteria: "Approved for submission.", durationDays: 7, approvalRequired: true },
      { key: "submission", name: "Submission", purpose: "Submit to the venue.", expectedOutputs: "Submission confirmation.", completionCriteria: "Submitted.", durationDays: 1, milestone: "Submitted" },
    ]),
  },
  {
    key: "proposal_only",
    version: 1,
    name: "Research proposal",
    description: "Prepare and defend a research proposal.",
    defaultFor: ["research_proposal"],
    stages: seq([
      { key: "topic_selection", name: "Topic selection and refinement", purpose: "Choose and narrow the topic.", expectedOutputs: "Working title and scope.", completionCriteria: "Topic agreed.", durationDays: 10, approvalRequired: true },
      { key: "problem", name: "Problem and questions", purpose: "State the problem, questions and objectives.", expectedOutputs: "Problem statement, questions, objectives.", completionCriteria: "Recorded in the project.", durationDays: 10 },
      { key: "lit_review", name: "Literature review", purpose: "Review prior work and identify the gap.", expectedOutputs: "Literature review and gap statement.", completionCriteria: "Draft complete.", durationDays: 21 },
      { key: "methodology", name: "Methodology", purpose: "Design the proposed study.", expectedOutputs: "Methodology section.", completionCriteria: "Draft complete.", durationDays: 14 },
      { key: "plan_budget", name: "Work plan and budget", purpose: "Schedule the study and estimate its costs.", expectedOutputs: "Gantt chart and budget.", completionCriteria: "Plan reviewed.", durationDays: 5, optional: true },
      { key: "proposal", name: "Proposal document", purpose: "Assemble the proposal.", expectedOutputs: "Proposal document.", completionCriteria: "Complete draft.", durationDays: 7 },
      { key: "defence", name: "Review and defence", purpose: "Present and revise after review.", expectedOutputs: "Approved proposal.", completionCriteria: "Proposal approved.", durationDays: 10, approvalRequired: true, milestone: "Proposal approved" },
    ]),
  },
  {
    key: "report",
    version: 1,
    name: "Business, market or technical report",
    description: "Scoping, research, analysis and delivery of a report.",
    defaultFor: ["business_research", "technical_report"],
    stages: seq([
      { key: "scoping", name: "Scoping", purpose: "Agree questions, audience and deliverables.", expectedOutputs: "Terms of reference.", completionCriteria: "Scope signed off.", durationDays: 5, approvalRequired: true },
      { key: "desk_research", name: "Desk research", purpose: "Gather existing sources and data.", expectedOutputs: "Source library and notes.", completionCriteria: "Key sources collected.", durationDays: 10 },
      { key: "data_collection", name: "Primary research", purpose: "Interviews, surveys or measurements.", expectedOutputs: "Collected data.", completionCriteria: "Collection complete.", durationDays: 15, optional: true },
      { key: "analysis", name: "Analysis", purpose: "Analyse the evidence.", expectedOutputs: "Findings and charts.", completionCriteria: "Findings agreed.", durationDays: 10 },
      { key: "drafting", name: "Report drafting", purpose: "Write the report and executive summary.", expectedOutputs: "Draft report.", completionCriteria: "Draft complete.", durationDays: 10 },
      { key: "review", name: "Review", purpose: "Stakeholder review and revisions.", expectedOutputs: "Final report.", completionCriteria: "Approved for release.", durationDays: 5, approvalRequired: true },
      { key: "delivery", name: "Delivery", purpose: "Deliver and present the report.", expectedOutputs: "Delivered report.", completionCriteria: "Delivered.", durationDays: 1, milestone: "Report delivered" },
    ]),
  },
];
