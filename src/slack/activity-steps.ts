import type { RunActivityEntry } from "../runs/run-activity-store.ts";
import { activityLabel } from "./activity-labels.ts";

export type SlackActivityState = "pending" | "in_progress" | "completed" | "skipped" | "failed" | "waiting_approval";

export interface SlackActivityStep {
  id: string;
  title: string;
  state: SlackActivityState;
}

const payloadOf = (entry: RunActivityEntry): Record<string, unknown> =>
  typeof entry.payload === "object" && entry.payload !== null ? (entry.payload as Record<string, unknown>) : {};

const identityOf = (entry: RunActivityEntry): string => {
  const payload = payloadOf(entry);
  for (const key of ["callId", "requestId", "approvalId"]) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  return `${entry.type}:${entry.seq}:${entry.createdAt}`;
};

export function projectActivitySteps(
  entries: RunActivityEntry[],
  prior: readonly SlackActivityStep[] = [],
): SlackActivityStep[] {
  const steps = new Map(prior.map((step) => [step.id, { ...step }]));
  for (const entry of entries) {
    const payload = payloadOf(entry);
    const id = identityOf(entry);
    if (entry.type === "tool_call") {
      const title = activityLabel(entry);
      if (!title || steps.has(id)) continue;
      steps.set(id, { id, title, state: "in_progress" });
      continue;
    }
    const step = steps.get(id);
    if (entry.type === "tool_result" && step) {
      if (payload.blocked === "needs_approval") step.state = "waiting_approval";
      else if (step.state !== "waiting_approval") step.state = payload.isError === true ? "failed" : "completed";
      continue;
    }
    if (entry.type === "approval_request") {
      if (step) step.state = "waiting_approval";
      else steps.set(id, { id, title: "Waiting for approval", state: "waiting_approval" });
      continue;
    }
    if (entry.type === "approval_resolved") {
      if (!step) continue;
      const approved = payload.approved === true || payload.decision === "approved" || payload.outcome === "approved";
      step.state = approved ? "in_progress" : "skipped";
    }
  }
  return [...steps.values()];
}
