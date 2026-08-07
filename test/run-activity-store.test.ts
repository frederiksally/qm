import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryRunActivityStore,
  RUN_ACTIVITY_TTL_MS,
  type RunActivityEntry,
} from "../src/runs/run-activity-store.ts";

const entry = (seq: number, type = "browser_status", createdAt = 0): RunActivityEntry => ({
  seq,
  parentSeq: null,
  type,
  payload: { text: `s${seq}` },
  createdAt,
});

test("append/list preserves arrival order and isolates runs", async () => {
  const s = createMemoryRunActivityStore();
  assert.deepEqual(await s.list("r1"), [], "unknown run is empty");
  await s.append("r1", entry(1, "tool_call"));
  await s.append("r1", entry(2, "browser_status"));
  await s.append("r2", entry(1, "tool_call"));
  const r1 = await s.list("r1");
  assert.deepEqual(
    r1.map((e) => e.type),
    ["tool_call", "browser_status"],
    "arrival order preserved",
  );
  assert.equal((await s.list("r2")).length, 1, "runs are isolated");
});

test("list returns a copy — mutating it can't corrupt the store", async () => {
  const s = createMemoryRunActivityStore();
  await s.append("r1", entry(1));
  (await s.list("r1")).push(entry(99));
  assert.equal((await s.list("r1")).length, 1);
});

test("prunes a run's feed once its entries age past the TTL", async () => {
  let now = 1_000_000;
  const s = createMemoryRunActivityStore(() => now);
  await s.append("old", entry(1, "browser_status", now));
  assert.equal((await s.list("old")).length, 1);
  now += RUN_ACTIVITY_TTL_MS + 120_000;
  await s.append("fresh", entry(1, "browser_status", now));
  assert.equal((await s.list("old")).length, 0, "the stale run's feed was pruned");
  assert.equal((await s.list("fresh")).length, 1, "the fresh entry survives");
});

test("incremental reads preserve arrival order across unrelated seq ranges", async () => {
  const s = createMemoryRunActivityStore();
  await s.append("r1", entry(2_000_000, "browser_status"));
  const first = await s.read("r1");
  await s.append("r1", entry(2, "tool_call"));
  const second = await s.read("r1", first.cursor);
  assert.deepEqual(second.entries.map((e) => e.seq), [2]);
  assert.equal(second.gap, false);
});

test("memory activity remains rolling and reports a stale-cursor gap", async () => {
  const s = createMemoryRunActivityStore();
  await s.append("r1", entry(0));
  const first = await s.read("r1");
  for (let i = 1; i <= 2_100; i++) await s.append("r1", entry(i));
  const page = await s.read("r1", first.cursor, 2_000);
  assert.equal(page.gap, true);
  assert.equal(page.entries.length, 2_000);
  assert.equal(page.entries[0]!.seq, 101);
  assert.equal(page.entries.at(-1)!.seq, 2_100);
});
