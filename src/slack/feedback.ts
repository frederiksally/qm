import type { SlackCoreClient } from "../api/slack-core-client.ts";

export const FEEDBACK_ACTION_ID = "qm_feedback";

export function withFeedbackControls(
  content: Array<Record<string, unknown>>,
  runId: string,
): Array<Record<string, unknown>> {
  return [
    ...content,
    {
      type: "context_actions",
      elements: [
        {
          type: "feedback_buttons",
          action_id: FEEDBACK_ACTION_ID,
          positive_button: { text: { type: "plain_text", text: "Helpful" }, value: `positive:${runId}` },
          negative_button: { text: { type: "plain_text", text: "Not helpful" }, value: `negative:${runId}` },
        },
      ],
    },
  ];
}

export function createFeedback(core: SlackCoreClient): {
  registerActions(app: { action(pattern: string, handler: (args: any) => Promise<void>): void }): void;
} {
  const handle = async ({ ack, body, action }: any): Promise<void> => {
    await ack();
    const match = /^(positive|negative):([A-Za-z0-9_-]+)$/.exec(String(action?.value ?? ""));
    if (!match) return;
    const channel = String(body?.channel?.id ?? body?.container?.channel_id ?? "");
    const messageTs = String(body?.message?.ts ?? "");
    const teamId = String(body?.team?.id ?? body?.team_id ?? "");
    const actorId = String(body?.user?.id ?? "");
    if (!channel || !messageTs || !teamId || !actorId) return;
    await core
      .recordFeedback({
        teamId,
        actorId,
        channel,
        messageTs,
        runId: match[2]!,
        outcome: match[1] as "positive" | "negative",
      })
      .catch(() => {});
  };
  return { registerActions: (app) => app.action(FEEDBACK_ACTION_ID, handle) };
}
