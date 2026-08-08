import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeedback, FEEDBACK_ACTION_ID, withFeedbackControls } from "../src/slack/feedback.ts";

test("feedback controls preserve visible message content and bind both outcomes to one run", () => {
  const content = [{ type: "section", text: { type: "mrkdwn", text: "Answer" } }];
  assert.deepEqual(withFeedbackControls(content, "run-1"), [
    ...content,
    {
      type: "context_actions",
      elements: [
        {
          type: "feedback_buttons",
          action_id: FEEDBACK_ACTION_ID,
          positive_button: { text: { type: "plain_text", text: "Helpful" }, value: "positive:run-1" },
          negative_button: { text: { type: "plain_text", text: "Not helpful" }, value: "negative:run-1" },
        },
      ],
    },
  ]);
});

test("feedback acknowledges first and records authenticated surface fields", async () => {
  const events: string[] = [];
  let handler: ((args: any) => Promise<void>) | undefined;
  const records: unknown[] = [];
  createFeedback({
    recordFeedback: async (record: unknown) => {
      events.push("record");
      records.push(record);
    },
  } as any).registerActions({
    action(actionId, next) {
      assert.equal(actionId, FEEDBACK_ACTION_ID);
      handler = next;
    },
  });
  await handler?.({
    ack: async () => void events.push("ack"),
    action: { value: "negative:run-1" },
    body: {
      team: { id: "T1" },
      user: { id: "U1" },
      channel: { id: "D1" },
      message: { ts: "171.003" },
    },
  });
  assert.deepEqual(events, ["ack", "record"]);
  assert.deepEqual(records, [
    { teamId: "T1", actorId: "U1", channel: "D1", messageTs: "171.003", runId: "run-1", outcome: "negative" },
  ]);
});

test("feedback ignores spoofed values and incomplete bodies", async () => {
  let handler: ((args: any) => Promise<void>) | undefined;
  let records = 0;
  createFeedback({ recordFeedback: async () => void records++ } as any).registerActions({
    action(_actionId, next) {
      handler = next;
    },
  });
  const ack = async (): Promise<void> => undefined;
  await handler?.({ ack, action: { value: "positive:run 1" }, body: {} });
  await handler?.({ ack, action: { value: "positive:run-1" }, body: {} });
  assert.equal(records, 0);
});
