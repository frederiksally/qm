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

test("stream presenter forces a short first flush, checkpoints, and finalizes once", async () => {
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
  });
  presenter.pushDelta("short");
  assert.equal(await presenter.finish("short"), "delivered");
  assert.deepEqual(calls, ["append", "checkpoint:S1", "stop", "finalize:S1:short"]);
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
  presenter.pushDelta(`${"a".repeat(11_999)}😀b`);
  assert.equal(await presenter.finish("done"), "delivered");
  assert.deepEqual(appends.map((value) => value.length), [11_999, 3]);
  assert.equal(appends.join(""), `${"a".repeat(11_999)}😀b`);
});

test("live text applies the same 40000-character ceiling as terminal delivery", async () => {
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
  presenter.pushDelta(`${"a".repeat(39_999)}😀tail`);
  assert.equal(await presenter.finish("done"), "delivered");
  assert.equal(appends.join("").length, 40_000);
  assert.equal(appends.join("").endsWith("…"), true);
});

test("a delta after exactly 40000 live characters cannot overflow the ceiling", async () => {
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
  presenter.pushDelta("a".repeat(40_000));
  presenter.pushDelta("overflow");
  assert.equal(await presenter.finish("done"), "delivered");
  assert.equal(appends.join("").length, 40_000);
});

test("task chunks preserve Unicode titles and bound opaque ids", async () => {
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
  assert.equal(await presenter.finish("done"), "delivered");
  assert.match(String(chunks[0]?.id), /^task:[a-f0-9]{64}$/);
  assert.equal(Array.from(String(chunks[0]?.title)).length, 256);
  assert.equal(String(chunks[0]?.title).endsWith("😀"), true);
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
  assert.equal(await presenter.finish("final"), "recoverable");
});

test("discard removes an opened stream and leaves a never-opened stream alone", async () => {
  const removed: string[] = [];
  const streamer = {
    ts: undefined as string | undefined,
    async append() {
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
  await presenter.discard();
  presenter.pushDelta("partial");
  await presenter.discard();
  assert.deepEqual(removed, ["S1"]);
});
