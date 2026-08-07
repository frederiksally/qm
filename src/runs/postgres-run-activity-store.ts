import { createPgPool } from "../persistence/pg-pool.ts";
import { RUN_ACTIVITY_TTL_MS, type RunActivityEntry, type RunActivityStore } from "./run-activity-store.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS run_activity(
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL,
    seq BIGINT NOT NULL,
    parent_seq BIGINT,
    type TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_run_activity_run ON run_activity(run_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_run_activity_created ON run_activity(created_at)`,
];

const PRUNE_INTERVAL_MS = 60_000;

export function createPostgresRunActivityStore(connectionString: string): RunActivityStore {
  const pg = createPgPool(connectionString, SCHEMA);
  const q = pg.query;
  let nextPruneAt = Number.NEGATIVE_INFINITY;

  return {
    async append(runId, entry) {
      const t = Date.now();
      if (t >= nextPruneAt) {
        nextPruneAt = t + PRUNE_INTERVAL_MS;
        await q("DELETE FROM run_activity WHERE created_at < $1", [t - RUN_ACTIVITY_TTL_MS]);
      }
      await q(
        `INSERT INTO run_activity(run_id, seq, parent_seq, type, payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [runId, entry.seq, entry.parentSeq, entry.type, JSON.stringify(entry.payload ?? null), entry.createdAt],
      );
    },

    async list(runId) {
      const { rows } = await q(
        `SELECT seq, parent_seq, type, payload, created_at FROM run_activity WHERE run_id=$1 ORDER BY id`,
        [runId],
      );
      return rows.map((r): RunActivityEntry => ({
        seq: Number(r.seq),
        parentSeq: r.parent_seq == null ? null : Number(r.parent_seq),
        type: r.type as string,
        payload: r.payload,
        createdAt: Number(r.created_at),
      }));
    },

    async read(runId, rawCursor, rawLimit = 200) {
      const cursor = rawCursor === undefined ? undefined : Number(rawCursor);
      const limit = Math.max(1, Math.min(2_000, Math.floor(rawLimit)));
      const { rows } = await q(
        `SELECT id, seq, parent_seq, type, payload, created_at
           FROM run_activity
          WHERE run_id=$1 AND ($2::bigint IS NULL OR id>$2)
          ORDER BY id
          LIMIT $3`,
        [runId, cursor ?? null, limit],
      );
      let gap = false;
      if (cursor !== undefined) {
        const existing = await q(`SELECT 1 FROM run_activity WHERE run_id=$1 AND id<=$2 LIMIT 1`, [runId, cursor]);
        const any = await q(`SELECT 1 FROM run_activity WHERE run_id=$1 LIMIT 1`, [runId]);
        gap = existing.rows.length === 0 && any.rows.length > 0;
      }
      const selected = gap
        ? (
            await q(
              `SELECT id, seq, parent_seq, type, payload, created_at
                 FROM run_activity WHERE run_id=$1 ORDER BY id LIMIT $2`,
              [runId, limit],
            )
          ).rows
        : rows;
      const entries = selected.map((r): RunActivityEntry => ({
        seq: Number(r.seq),
        parentSeq: r.parent_seq == null ? null : Number(r.parent_seq),
        type: r.type as string,
        payload: r.payload,
        createdAt: Number(r.created_at),
      }));
      const next = selected.at(-1)?.id ?? cursor;
      return { entries, ...(next !== undefined ? { cursor: String(next) } : {}), gap };
    },

    async close() {
      await pg.close();
    },
  };
}
