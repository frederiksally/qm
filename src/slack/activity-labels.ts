import type { RunActivityEntry } from "../runs/run-activity-store.ts";

const TOOL_LABELS: Record<string, string> = {
  execute: "Running a command",
  read: "Reading a file",
  write: "Writing a file",
  publish: "Publishing files",
  history: "Reviewing conversation history",
  share: "Sharing an artifact",
  memory: "Working with memory",
  guidance: "Reviewing guidance",
  background: "Managing background work",
  cron: "Managing scheduled work",
  slack: "Working in Slack",
  query_brain: "Looking up relevant context",
  brain_page: "Reading background context",
  brain_recent: "Checking recent updates",
};

const ACTION_LABELS: Record<string, string> = {
  "memory:search": "Searching memory",
  "memory:remember": "Writing to memory",
  "memory:read": "Reading memory",
  "memory:rewrite": "Updating memory",
  "guidance:read": "Reading guidance",
  "guidance:write": "Updating guidance",
  "background:start": "Starting background work",
  "background:poll": "Checking background work",
  "background:stop": "Stopping background work",
  "background:list": "Reviewing background work",
  "background:write": "Updating background work",
  "background:watch": "Watching background work",
  "background:unwatch": "Updating background work",
  "cron:create": "Creating a schedule",
  "cron:list": "Reviewing schedules",
  "cron:get": "Reading a schedule",
  "cron:runs": "Reviewing scheduled runs",
  "cron:patch": "Updating a schedule",
  "cron:delete": "Deleting a schedule",
  "cron:run": "Running a schedule",
  "cron:disable": "Disabling a schedule",
  "cron:retarget": "Retargeting a schedule",
  "slack:post": "Posting in Slack",
  "slack:reach": "Reaching someone in Slack",
  "slack:react": "Reacting in Slack",
  "slack:edit": "Editing a Slack message",
  "slack:delete": "Deleting a Slack message",
  "slack:read_thread": "Reading a Slack thread",
  "slack:whats_new": "Checking recent Slack activity",
  "slack:search": "Searching Slack",
  "slack:read_members": "Reading Slack members",
  "slack:read_file": "Reading a Slack file",
};

export function activityLabel(entry: RunActivityEntry): string | undefined {
  if (entry.type !== "tool_call") return undefined;
  const payload = typeof entry.payload === "object" && entry.payload !== null ? entry.payload : {};
  const tool = typeof (payload as { tool?: unknown }).tool === "string" ? (payload as { tool: string }).tool : "";
  const action =
    typeof (payload as { action?: unknown }).action === "string" ? (payload as { action: string }).action : "";
  if (!tool || tool === "finish_silently" || tool === "stay_silent") return undefined;
  return ACTION_LABELS[`${tool}:${action}`] ?? TOOL_LABELS[tool];
}
