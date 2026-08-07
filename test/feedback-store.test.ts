import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryFeedbackStore } from "../src/surface-cache/feedback-store.ts";

test("feedback is idempotent per actor and run", async () => {
  const store = createMemoryFeedbackStore();
  const base = { teamId: "T1", actorId: "U1", channel: "D1", messageTs: "1.1", runId: "R1", createdAt: 1 };
  await store.record({ ...base, outcome: "positive" });
  await store.record({ ...base, outcome: "negative", createdAt: 2 });
  assert.deepEqual(await store.list("R1"), [{ ...base, outcome: "negative", createdAt: 2 }]);
});
