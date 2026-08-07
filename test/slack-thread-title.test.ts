import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveThreadTitle, setThreadTitle } from "../src/slack/thread-title.ts";

test("deriveThreadTitle uses one bounded plain-text clause", () => {
  assert.equal(deriveThreadTitle("**Deploy report.**\nEverything passed."), "Deploy report.");
  assert.equal(deriveThreadTitle("  Search   the wiki — then summarize it"), "Search the wiki");
  assert.equal(deriveThreadTitle("`code` and <https://example.com|docs>"), "code and docs");
  assert.equal(deriveThreadTitle("x".repeat(100))?.length, 80);
  assert.equal(deriveThreadTitle("  ** `  "), undefined);
});

test("setThreadTitle sends a title and swallows arbitrary rejection", async () => {
  const calls: any[] = [];
  await setThreadTitle(
    { assistant: { threads: { setTitle: async (body: any) => void calls.push(body) } } },
    "D1",
    "1.1",
    "Hello there. More",
  );
  assert.deepEqual(calls, [{ channel_id: "D1", thread_ts: "1.1", title: "Hello there." }]);
  await setThreadTitle(
    { assistant: { threads: { setTitle: async () => Promise.reject(new Error("offline")) } } },
    "D1",
    "1.1",
    "Hello",
  );
});
