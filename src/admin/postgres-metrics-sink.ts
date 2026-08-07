import { createPostgresEventSink, type EventColumn } from "./scoped-event-sink.ts";
import type { MetricsSink, TurnMetricSample } from "./metrics-sink.ts";
import { sleep } from "../util/async.ts";

const COLUMNS: readonly EventColumn<keyof TurnMetricSample & string>[] = [
  ["ts", "ts", "BIGINT", "number", true],
  ["scope_label", "scopeLabel", "TEXT", "string", true],
  ["session_id", "sessionId", "TEXT", "string"],
  ["turn_seq", "turnSeq", "INT", "number"],
  ["run_id", "runId", "TEXT", "string"],
  ["status", "status", "TEXT", "string", true],
  ["total_ms", "totalMs", "INT", "number", true],
  ["ttft_ms", "ttftMs", "INT", "number"],
  ["intake_preamble_ms", "intakePreambleMs", "INT", "number"],
  ["dispatch_ms", "dispatchMs", "INT", "number"],
  ["provisioned", "provisioned", "BOOLEAN", "boolean"],
  ["cold_start", "coldStart", "BOOLEAN", "boolean"],
  ["model_calls", "modelCalls", "INT", "number"],
  ["tool_calls", "toolCalls", "INT", "number"],
  ["provision_ms", "provisionMs", "INT", "number"],
  ["materialize_ms", "materializeMs", "INT", "number"],
  ["creds_ms", "credsMs", "INT", "number"],
  ["layers_ms", "layersMs", "INT", "number"],
  ["compile_ms", "compileMs", "INT", "number"],
  ["recall_ms", "recallMs", "INT", "number"],
  ["exec_ms", "execMs", "INT", "number"],
  ["stream_ms", "streamMs", "INT", "number"],
  ["lease_ms", "leaseMs", "INT", "number"],
  ["capture_ms", "captureMs", "INT", "number"],
  ["ingress_ms", "ingressMs", "INT", "number"],
  ["detect_ms", "detectMs", "INT", "number"],
  ["compact_ms", "compactMs", "INT", "number"],
  ["queue_ms", "queueMs", "INT", "number"],
  ["deliver_ms", "deliverMs", "INT", "number"],
  ["slack_inflight_ms", "slackInflightMs", "INT", "number"],
  ["slack_stream_published", "slackStreamPublished", "INT", "number"],
  ["slack_stream_received", "slackStreamReceived", "INT", "number"],
  ["slack_stream_published_instance", "slackStreamPublishedInstance", "TEXT", "string"],
  ["slack_stream_received_instance", "slackStreamReceivedInstance", "TEXT", "string"],
  ["resumed_from_seq", "resumedFromSeq", "INT", "number"],
  ["cache_read", "cacheRead", "BIGINT", "number"],
  ["cache_write", "cacheWrite", "BIGINT", "number"],
  ["uncached_input", "uncachedInput", "BIGINT", "number"],
];

const EXTRA_SCHEMA_STATEMENTS = [
  ...COLUMNS.filter(([, , , , required]) => !required).map(
    ([db, , sqlType]) => `ALTER TABLE turn_metrics ADD COLUMN IF NOT EXISTS ${db} ${sqlType}`,
  ),
  "CREATE INDEX IF NOT EXISTS turn_metrics_by_ts ON turn_metrics(ts DESC)",
  "CREATE INDEX IF NOT EXISTS turn_metrics_by_scope_ts ON turn_metrics(scope_label, ts DESC)",
  "CREATE INDEX IF NOT EXISTS turn_metrics_by_session ON turn_metrics(session_id, ts DESC)",
  "CREATE INDEX IF NOT EXISTS turn_metrics_by_run ON turn_metrics(run_id)",
  `CREATE TABLE IF NOT EXISTS slack_stream_receipts(
    run_id TEXT PRIMARY KEY,
    received INT,
    instance TEXT
  )`,
];

export function createPostgresMetricsSink(connectionString: string): MetricsSink {
  const sink = createPostgresEventSink<TurnMetricSample>({
    connectionString,
    table: "turn_metrics",
    columns: COLUMNS,
    extraSchemaStatements: EXTRA_SCHEMA_STATEMENTS,
    defaultLimit: 5000,
    equalityFilters: { scopeId: "scope_label", sessionId: "session_id" },
    persistErrorMessage: "[metrics] failed to persist turn metric:",
  });

  return {
    record: sink.record,
    async updateByRunId(runId, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.deliverMs !== undefined) {
        params.push(patch.deliverMs);
        sets.push(`deliver_ms = $${params.length}`);
      }
      if (patch.slackInflightMs !== undefined) {
        params.push(patch.slackInflightMs);
        sets.push(`slack_inflight_ms = $${params.length}`);
      }
      if (patch.slackStreamReceived !== undefined) {
        params.push(patch.slackStreamReceived);
        sets.push(`slack_stream_received = $${params.length}`);
      }
      if (patch.slackStreamReceivedInstance !== undefined) {
        params.push(patch.slackStreamReceivedInstance);
        sets.push(`slack_stream_received_instance = $${params.length}`);
      }
      if (!sets.length) return;
      if (patch.slackStreamReceived !== undefined || patch.slackStreamReceivedInstance !== undefined) {
        await sink.q(
          `INSERT INTO slack_stream_receipts(run_id, received, instance) VALUES($1,$2,$3)
           ON CONFLICT(run_id) DO UPDATE SET
             received=COALESCE(EXCLUDED.received, slack_stream_receipts.received),
             instance=COALESCE(EXCLUDED.instance, slack_stream_receipts.instance)`,
          [runId, patch.slackStreamReceived ?? null, patch.slackStreamReceivedInstance ?? null],
        );
      }
      params.push(runId);
      for (const delay of [0, 25, 100, 400]) {
        if (delay) await sleep(delay);
        try {
          const rows = await sink.q(
            `UPDATE turn_metrics SET ${sets.join(", ")} WHERE run_id = $${params.length} RETURNING run_id`,
            params,
          );
          if (rows.length) return;
        } catch (err) {
          console.error("[metrics] failed to patch turn metric:", err);
        }
      }
    },
    async list(opts = {}) {
      const rows = await sink.list(opts);
      const runIds = rows.flatMap((row) => (row.runId ? [row.runId] : []));
      if (!runIds.length) return rows;
      const receipts = await sink.q(
        `SELECT run_id, received, instance FROM slack_stream_receipts WHERE run_id = ANY($1::text[])`,
        [runIds],
      );
      const byRun = new Map(receipts.map((row) => [String(row.run_id), row]));
      return rows.map((row) => {
        const receipt = row.runId ? byRun.get(row.runId) : undefined;
        if (!receipt) return row;
        return {
          ...row,
          ...(receipt.received == null ? {} : { slackStreamReceived: Number(receipt.received) }),
          ...(receipt.instance == null ? {} : { slackStreamReceivedInstance: String(receipt.instance) }),
        };
      });
    },
  };
}
