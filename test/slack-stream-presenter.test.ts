import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackDeltaProjector } from "../src/slack/stream-projector.ts";
import { createStreamPresenter } from "../src/slack/stream-presenter.ts";

test("delta projector withholds directives split across chunks", () => {
  const projector = createSlackDeltaProjector();
  assert.equal(projector.push("Hello [[rea"), "Hello ");
  assert.equal(projector.push("ct: eyes]] world"), " world");
  assert.equal(projector.push(" [[ask-agent: <@U1> | se"), " ");
  assert.equal(projector.push("cret task]] done"), " done");
  assert.equal(projector.finish(), "");
});

test("delta projector escapes live mentions and markup delimiters", () => {
  const projector = createSlackDeltaProjector();
  assert.equal(projector.push("Hello <@U1> & <https://example.com>"), "Hello &lt;@U1&gt; &amp; &lt;https://example.com&gt;");
});

test("stream presenter forces a short first flush, checkpoints, and completes with native stop", async () => {
  const calls: string[] = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append() {
      calls.push("append");
      this.ts = "S1";
    },
    async stop() {
      calls.push("stop");
    },
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async (ts) => void calls.push(`checkpoint:${ts}`),
    finalize: async (ts, text) => void calls.push(`finalize:${ts}:${text}`),
    remove: async () => {},
    onDelivered: (ts, text) => void calls.push(`delivered:${ts}:${text}`),
  });
  presenter.pushDelta("short");
  assert.equal(await presenter.finish("short"), "delivered");
  assert.deepEqual(calls, ["append", "checkpoint:S1", "stop", "delivered:S1:short"]);
});

test("only the first short text append forces an SDK flush", async () => {
  const appends: Array<{ markdown_text?: string; chunks?: Array<Record<string, unknown>> }> = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append(args: { markdown_text?: string; chunks?: Array<Record<string, unknown>> }) {
      appends.push(args);
      if (args.chunks) this.ts = "S1";
    },
    async stop() {},
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async () => {},
  });
  presenter.pushDelta("a");
  presenter.pushDelta("b");
  presenter.pushDelta("c");
  assert.equal(await presenter.finish("abc"), "delivered");
  assert.deepEqual(appends, [
    { markdown_text: "a", chunks: [] },
    { markdown_text: "b" },
    { markdown_text: "c" },
  ]);
});

test("failure before a stream ts permits normal-post fallback", async () => {
  const presenter = createStreamPresenter({
    create: () => ({
      async append() {
        throw new Error("start failed");
      },
      async stop() {},
    }),
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async () => {},
  });
  presenter.pushDelta("text");
  assert.equal(await presenter.finish("text"), "none");
});

test("an uncheckpointed stream is removed before normal-post fallback", async () => {
  const calls: string[] = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append() {
      this.ts = "S1";
    },
    async stop() {
      calls.push("stop");
    },
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {
      throw new Error("checkpoint failed");
    },
    finalize: async () => void calls.push("finalize"),
    remove: async (ts) => void calls.push(`remove:${ts}`),
  });
  presenter.pushDelta("partial");
  assert.equal(await presenter.finish("final"), "none");
  assert.deepEqual(calls, ["stop", "remove:S1"]);
});

test("a direct stream never replaces a successfully streamed reply", async () => {
  const calls: string[] = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append() {
      this.ts = "S1";
    },
    async stop() {
      calls.push("stop");
    },
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async () => void calls.push("remove"),
  });
  presenter.pushDelta("draft");
  assert.equal(await presenter.finish("final", undefined, "final"), "delivered");
  assert.deepEqual(calls, ["stop"]);
});

test("an empty terminal answer does not delete a successfully streamed reply", async () => {
  const calls: string[] = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append() {
      this.ts = "S1";
    },
    async stop() {
      calls.push("stop");
    },
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async () => void calls.push("remove"),
  });
  presenter.pushDelta("draft");
  assert.equal(await presenter.finish("", undefined, ""), "delivered");
  assert.deepEqual(calls, ["stop"]);
});

test("a tool turn keeps its narration, replaces activity, and appends only the authoritative answer", async () => {
  const appends: Array<{ markdown_text?: string; chunks?: Array<Record<string, unknown>> }> = [];
  const stops: Array<{ markdown_text?: string }> = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append(args: { markdown_text?: string; chunks?: Array<Record<string, unknown>> }) {
      this.ts ??= "S1";
      appends.push(args);
    },
    async stop(args: { markdown_text?: string } = {}) {
      stops.push(args);
    },
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async () => {},
  });
  presenter.pushDelta("I’ll check that.");
  presenter.beginToolWork();
  presenter.pushDelta("Provisional reasoning that must stay hidden.");
  presenter.pushActivity([{ id: "tool", title: "Looking up relevant context", state: "in_progress" }]);
  assert.equal(await presenter.finish("The answer is 42.", undefined, "The answer is 42."), "delivered");
  assert.equal(appends.filter(({ markdown_text }) => markdown_text).map(({ markdown_text }) => markdown_text).join(""), "I’ll check that.");
  assert.equal(stops[0]?.markdown_text, "\n\nThe answer is 42.");
  assert.equal(appends.some(({ markdown_text }) => markdown_text?.includes("Provisional reasoning")), false);
});

test("a long tool narration always leaves room for the authoritative answer", async () => {
  const stops: Array<{ markdown_text?: string }> = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append() {
      this.ts ??= "S1";
    },
    async stop(args: { markdown_text?: string } = {}) {
      stops.push(args);
    },
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async () => {},
  });
  presenter.pushDelta("n".repeat(40_000));
  presenter.beginToolWork();
  assert.equal(await presenter.finish("a".repeat(15_000)), "delivered");
  assert.ok(stops[0]?.markdown_text?.startsWith("\n\n"));
  assert.equal(stops[0]?.markdown_text?.endsWith("…"), true);
  assert.equal(stops[0]?.markdown_text?.length, 12_000);
});

test("markdown text fields split at Unicode-safe 12000-character boundaries", async () => {
  const appends: string[] = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append(args: { markdown_text?: string }) {
      this.ts ??= "S1";
      appends.push(args.markdown_text ?? "");
    },
    async stop() {},
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async () => {},
  });
  const text = `${"a".repeat(11_999)}😀b`;
  presenter.pushDelta(text);
  assert.equal(await presenter.finish(text), "delivered");
  assert.deepEqual(appends.map((value) => value.length), [11_999, 3]);
  assert.equal(appends.join(""), `${"a".repeat(11_999)}😀b`);
});

test("live text applies the same 40000-character ceiling as terminal delivery", async () => {
  const appends: string[] = [];
  let stopped = "";
  const streamer = {
    ts: undefined as string | undefined,
    async append(args: { markdown_text?: string }) {
      this.ts ??= "S1";
      appends.push(args.markdown_text ?? "");
    },
    async stop(args: { markdown_text?: string } = {}) {
      stopped = args.markdown_text ?? "";
    },
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async () => {},
  });
  const text = `${"a".repeat(39_999)}😀tail`;
  presenter.pushDelta(text);
  assert.equal(await presenter.finish(text), "delivered");
  assert.equal(`${appends.join("")}${stopped}`.length, 40_000);
  assert.equal(`${appends.join("")}${stopped}`.endsWith("…"), true);
});

test("a delta after exactly 40000 live characters cannot overflow the ceiling", async () => {
  const appends: string[] = [];
  let stopped = "";
  const streamer = {
    ts: undefined as string | undefined,
    async append(args: { markdown_text?: string }) {
      this.ts ??= "S1";
      appends.push(args.markdown_text ?? "");
    },
    async stop(args: { markdown_text?: string } = {}) {
      stopped = args.markdown_text ?? "";
    },
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async () => {},
  });
  presenter.pushDelta("a".repeat(40_000));
  presenter.pushDelta("overflow");
  assert.equal(await presenter.finish(`${"a".repeat(40_000)}overflow`), "delivered");
  assert.equal(`${appends.join("")}${stopped}`.length, 40_000);
});

test("activity updates replace one stable card and preserve Unicode titles", async () => {
  const chunks: Array<Record<string, unknown>> = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append(args: { chunks?: Array<Record<string, unknown>> }) {
      this.ts ??= "S1";
      chunks.push(...(args.chunks ?? []));
    },
    async stop() {},
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async () => {},
  });
  presenter.pushActivity([{ id: "x".repeat(300), title: `${"a".repeat(255)}😀tail`, state: "in_progress" }]);
  presenter.pushActivity([
    { id: "first", title: "First", state: "completed" },
    { id: "second", title: "Second", state: "in_progress" },
  ]);
  assert.equal(await presenter.finish("done"), "delivered");
  assert.equal(chunks[0]?.id, "current_activity");
  assert.equal(chunks[1]?.id, "current_activity");
  assert.equal(chunks[1]?.title, "Second");
  assert.equal(chunks.at(-1)?.id, "current_activity");
  assert.equal(chunks.at(-1)?.status, "complete");
  assert.equal(Array.from(String(chunks[0]?.title)).length, 256);
  assert.equal(String(chunks[0]?.title).endsWith("😀"), true);
});

test("a placeholder step is replaced by real activity and completed on finish", async () => {
  const chunks: Array<Record<string, unknown>> = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append(args: { chunks?: Array<Record<string, unknown>> }) {
      this.ts ??= "S1";
      chunks.push(...(args.chunks ?? []));
    },
    async stop() {},
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async () => {},
  });
  presenter.pushActivity([{ id: "delayed", title: "Working on it", state: "in_progress" }]);
  presenter.pushActivity([{ id: "tool-1", title: "Looking up relevant context", state: "in_progress" }]);
  assert.equal(await presenter.finish("done"), "delivered");
  assert.deepEqual(
    chunks.map((chunk) => [chunk.id, chunk.title, chunk.status]),
    [
      ["current_activity", "Working on it", "in_progress"],
      ["current_activity", "Looking up relevant context", "in_progress"],
      ["current_activity", "Looking up relevant context", "complete"],
    ],
  );
});

test("activity pushed after finish or discard is dropped", async () => {
  const appends: Array<{ markdown_text?: string; chunks?: Array<Record<string, unknown>> }> = [];
  const stops: Array<{ markdown_text?: string }> = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append(args: { markdown_text?: string; chunks?: Array<Record<string, unknown>> }) {
      this.ts ??= "S1";
      appends.push(args);
    },
    async stop(args: { markdown_text?: string } = {}) {
      stops.push(args);
    },
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async () => {},
  });
  presenter.pushActivity([{ id: "delayed", title: "Working on it", state: "in_progress" }]);
  assert.equal(await presenter.finish("done"), "delivered");
  presenter.pushDelta("late text");
  presenter.beginToolWork();
  presenter.pushActivity([{ id: "late", title: "Late activity", state: "in_progress" }]);
  assert.equal(appends.length, 2);
  assert.equal(stops.length, 1);
  assert.equal(appends.every((append) => append.chunks?.[0]?.title === "Working on it"), true);
});

test("a post-flush finalize failure never permits a duplicate fallback post", async () => {
  const streamer = {
    ts: undefined as string | undefined,
    async append() {
      this.ts = "S1";
    },
    async stop() {
      throw new Error("stop failed");
    },
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {
      throw new Error("update failed");
    },
    remove: async () => {},
  });
  presenter.pushDelta("partial");
  assert.equal(await presenter.finish("partial"), "recoverable");
});

test("discard removes an opened stream, then drops later pushes", async () => {
  const removed: string[] = [];
  const appends: string[] = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append() {
      appends.push("append");
      this.ts = "S1";
    },
    async stop() {},
  };
  const presenter = createStreamPresenter({
    create: () => streamer,
    checkpoint: async () => {},
    finalize: async () => {},
    remove: async (ts) => void removed.push(ts),
  });
  presenter.pushDelta("opened");
  await presenter.discard();
  presenter.pushDelta("dropped");
  presenter.pushActivity([{ id: "late", title: "Late activity", state: "in_progress" }]);
  assert.deepEqual(removed, ["S1"]);
  assert.equal(appends.length, 1);
});
