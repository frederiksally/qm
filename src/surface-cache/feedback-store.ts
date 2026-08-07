import { orgId as configOrgId } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";

export type FeedbackOutcome = "positive" | "negative";

export interface FeedbackRecord {
  orgId?: string;
  teamId: string;
  actorId: string;
  channel: string;
  messageTs: string;
  runId: string;
  outcome: FeedbackOutcome;
  createdAt: number;
}

export interface FeedbackStore {
  record(record: FeedbackRecord): Promise<void>;
  list(runId: string): Promise<FeedbackRecord[]>;
  close(): Promise<void>;
}

export function createMemoryFeedbackStore(): FeedbackStore {
  const records = new Map<string, FeedbackRecord>();
  return {
    async record(record) {
      records.set(`${record.teamId}:${record.actorId}:${record.runId}`, { ...record });
    },
    async list(runId) {
      return [...records.values()].filter((record) => record.runId === runId);
    },
    async close() {},
  };
}

export function createPostgresFeedbackStore(connectionString: string): FeedbackStore {
  const orgId = configOrgId();
  const { q, close } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS slack_feedback(
      org_id TEXT NOT NULL, team_id TEXT NOT NULL, actor_id TEXT NOT NULL, channel TEXT NOT NULL,
      message_ts TEXT NOT NULL, run_id TEXT NOT NULL, outcome TEXT NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY(org_id, team_id, actor_id, run_id)
    )`,
    `CREATE INDEX IF NOT EXISTS slack_feedback_org_run ON slack_feedback(org_id, run_id)`,
  ]);
  return {
    async record(record) {
      await q(
        `INSERT INTO slack_feedback(org_id, team_id, actor_id, channel, message_ts, run_id, outcome, created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(org_id, team_id, actor_id, run_id) DO UPDATE
         SET channel=EXCLUDED.channel, message_ts=EXCLUDED.message_ts,
             outcome=EXCLUDED.outcome, created_at=EXCLUDED.created_at`,
        [orgId, record.teamId, record.actorId, record.channel, record.messageTs, record.runId, record.outcome, record.createdAt],
      );
    },
    async list(runId) {
      const rows = await q(
        `SELECT org_id, team_id, actor_id, channel, message_ts, run_id, outcome, created_at
           FROM slack_feedback WHERE org_id=$1 AND run_id=$2 ORDER BY created_at`,
        [orgId, runId],
      );
      return rows.map((row) => ({
        orgId: row.org_id as string,
        teamId: row.team_id as string,
        actorId: row.actor_id as string,
        channel: row.channel as string,
        messageTs: row.message_ts as string,
        runId: row.run_id as string,
        outcome: row.outcome as FeedbackOutcome,
        createdAt: Number(row.created_at),
      }));
    },
    close,
  };
}
