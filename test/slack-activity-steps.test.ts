import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunActivityEntry } from "../src/runs/run-activity-store.ts";
import { activityLabel } from "../src/slack/activity-labels.ts";
import { projectActivitySteps } from "../src/slack/activity-steps.ts";
import { createPiTools } from "../src/harness/pi-tools.ts";

const entry = (seq: number, type: string, payload: unknown): RunActivityEntry => ({
  seq,
  parentSeq: null,
  type,
  payload,
  createdAt: seq,
});

test("activity labels never expose payload contents", () => {
  for (const value of [
    entry(1, "tool_call", { tool: "execute", command: "password=secret" }),
    entry(2, "tool_call", { tool: "read", path: "/private/customer.txt" }),
    entry(3, "tool_call", { tool: "memory", action: "remember", body: "private memory" }),
  ]) {
    const label = activityLabel(value) ?? "";
    assert.doesNotMatch(label, /secret|private|customer/i);
  }
});

test("low-level internal tools do not become user-facing activity", () => {
  for (const tool of ["execute", "read", "write", "history", "memory", "guidance"])
    assert.equal(activityLabel(entry(1, "tool_call", { tool })), undefined);
});

test("internal context activity uses user-centered language", () => {
  assert.deepEqual(
    ["query_brain", "brain_page", "brain_recent"].map((tool, index) =>
      activityLabel(entry(index + 1, "tool_call", { tool })),
    ),
    ["Looking up relevant context", "Reading background context", "Checking recent updates"],
  );
});

test("every Pi tool schema action and approval-gate form has an explicit payload-safe policy", () => {
  const tools = [
    ...createPiTools({ current: null }, { controlTools: true }),
    ...createPiTools(
      { current: null },
      { brainPage: true, brainQuery: true, brainRecent: true, controlTools: true, surfaceTools: true },
    ),
  ];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    const schema = tool.parameters as {
      properties?: { action?: { anyOf?: Array<{ const?: unknown }> } };
    };
    const actions = (schema.properties?.action?.anyOf ?? [])
      .map((choice) => choice.const)
      .filter((value): value is string => typeof value === "string");
    const variants = actions.length ? actions : [undefined];
    for (const action of variants) {
      const sentinel = `SECRET_${tool.name}_${action ?? "gate"}`;
      const label = activityLabel(
        entry(1, "tool_call", {
          tool: tool.name,
          ...(action ? { action } : {}),
          command: sentinel,
          path: sentinel,
          query: sentinel,
          body: sentinel,
          recipient: sentinel,
        }),
      );
      if (["execute", "read", "write", "history", "memory", "guidance", "stay_silent", "finish_silently"].includes(tool.name))
        assert.equal(label, undefined);
      else assert.ok(label, `${tool.name}:${action ?? "approval-gate"}`);
      assert.doesNotMatch(label ?? "", new RegExp(sentinel));
    }
  }
});

test("projection preserves distinct calls, order, terminal states, and approval waiting", () => {
  const calls = [
    entry(1, "tool_call", { tool: "slack", action: "search", callId: "a" }),
    entry(2, "tool_call", { tool: "slack", action: "search", callId: "b" }),
    entry(3, "approval_request", { callId: "a" }),
    entry(4, "tool_result", { callId: "b", isError: true }),
  ];
  const projected = projectActivitySteps(calls);
  assert.deepEqual(projected.map(({ id, state }) => ({ id, state })), [
    { id: "a", state: "waiting_approval" },
    { id: "b", state: "failed" },
  ]);
  assert.deepEqual(projectActivitySteps(calls, projected), projected);
});

test("the strict gate for a hidden internal tool stays hidden", () => {
  const projected = projectActivitySteps([
    entry(1, "tool_call", { tool: "execute", callId: "gate-1", blocked: "needs_approval" }),
    entry(2, "tool_result", {
      tool: "execute",
      callId: "gate-1",
      blocked: "needs_approval",
      isError: true,
      result: "private payload",
    }),
  ]);
  assert.deepEqual(projected, []);
});
