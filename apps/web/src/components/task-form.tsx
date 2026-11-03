import { Field } from "./action-form";
import { PRIORITY_LABELS } from "./plan-ui";

interface Option {
  id: string;
  label: string;
}

/** Fields for creating a task (server component; works without JavaScript). */
export function NewTaskFields({ today, parents, stages, people }: { today: string; parents: Option[]; stages: Option[]; people: Option[] }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <Field label="Title" name="title" required maxLength={300} />
        <div className="field">
          <label htmlFor="f-kind">Type</label>
          <select id="f-kind" name="kind" className="input" defaultValue="task">
            <option value="task">Task</option>
            <option value="milestone">Milestone</option>
          </select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Start" name="startDate" type="date" defaultValue={today} required />
        <Field label="End" name="endDate" type="date" hint="Milestones use the start date." />
        <div className="field">
          <label htmlFor="f-priority">Priority</label>
          <select id="f-priority" name="priority" className="input" defaultValue="normal">
            {Object.entries(PRIORITY_LABELS).map(([k, l]) => (
              <option key={k} value={k}>{l}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="field">
          <label htmlFor="f-parent">Part of</label>
          <select id="f-parent" name="parentTaskId" className="input" defaultValue="">
            <option value="">— Top level —</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-stage">Stage</label>
          <select id="f-stage" name="stageId" className="input" defaultValue="">
            <option value="">—</option>
            {stages.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-assignee">Owner</label>
          <select id="f-assignee" name="assigneeUserId" className="input" defaultValue="">
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr] sm:items-end">
        <Field label="Estimate (hours)" name="estimateHours" type="number" min={0} step={0.5} />
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" name="requiresCompletionApproval" /> Completion needs approval
        </label>
      </div>
    </>
  );
}
