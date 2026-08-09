import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slackReplyArgs,
  botIdentityArgs,
  botIdentityFromEnv,
  encodeDeliveryTarget,
  parseDeliveryTarget,
  deliveryCandidatesFor,
  createDeliveryTracker,
  deliverWithRetry,
  postWithVerify,
  channelSurfaceUrl,
  channelWelcomeMessage,
  onBotJoinedChannel,
} from "../src/slack/lib.ts";

test("slackReplyArgs keeps channel replies thread-only and never broadcasts them", () => {
  assert.deepEqual(slackReplyArgs("C1", "reply", "123.45", { threadOnly: true }), {
    channel: "C1",
    text: "reply",
    thread_ts: "123.45",
    reply_broadcast: false,
  });
  assert.deepEqual(slackReplyArgs("D1", "reply", "123.45"), {
    channel: "D1",
    text: "reply",
    thread_ts: "123.45",
  });
});

test("botIdentityFromEnv reads the display-name/icon knobs and trims them", () => {
  assert.deepEqual(botIdentityFromEnv({} as NodeJS.ProcessEnv), {});
  assert.deepEqual(
    botIdentityFromEnv({ SLACK_BOT_DISPLAY_NAME: "  agent · singapore-v2  " } as unknown as NodeJS.ProcessEnv),
    { username: "agent · singapore-v2" },
  );
  assert.deepEqual(
    botIdentityFromEnv({
      SLACK_BOT_DISPLAY_NAME: "agent · singapore-v2",
      SLACK_BOT_ICON_EMOJI: ":robot_face:",
    } as unknown as NodeJS.ProcessEnv),
    { username: "agent · singapore-v2", icon_emoji: ":robot_face:" },
  );
});

test("botIdentityArgs/slackReplyArgs stay a no-op without an env override", () => {
  assert.deepEqual(botIdentityArgs(), {});
  assert.deepEqual(slackReplyArgs("C1", "reply", undefined), {
    channel: "C1",
    text: "reply",
  });
});

test("slackReplyArgs can suppress Slack link and media unfurls per message", () => {
  assert.deepEqual(slackReplyArgs("C1", "see https://x.com/a/status/1", undefined, { unfurlLinks: false }), {
    channel: "C1",
    text: "see https://x.com/a/status/1",
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.deepEqual(slackReplyArgs("C1", "see https://x.com/a/status/1", undefined), {
    channel: "C1",
    text: "see https://x.com/a/status/1",
  });
});

test("delivery target round-trips channel + thread, and channel-only when not threaded", () => {
  const threaded = encodeDeliveryTarget("C123", "1699999999.001200");
  assert.equal(threaded, "C123:1699999999.001200");
  assert.deepEqual(parseDeliveryTarget(threaded), { channel: "C123", threadTs: "1699999999.001200" });

  const root = encodeDeliveryTarget("D456");
  assert.equal(root, "D456");
  assert.deepEqual(parseDeliveryTarget(root), { channel: "D456" });
});

test("parseDeliveryTarget splits only on the first ':' and tolerates a bare channel", () => {
  assert.deepEqual(parseDeliveryTarget("C9:1.2"), { channel: "C9", threadTs: "1.2" });
  assert.deepEqual(parseDeliveryTarget("C9"), { channel: "C9" });
});

test("deliveryCandidatesFor: a channel offers this-thread (default) and the-whole-channel", () => {
  const cands = deliveryCandidatesFor("channel", "C123", "1699999999.001200", "eng");
  assert.ok(cands);
  assert.equal(cands.length, 2);
  assert.deepEqual(cands[0], { target: "C123:1699999999.001200", label: "this thread" });
  assert.equal(cands[1]!.target, "C123");
  assert.equal(cands[1]!.label, "#eng (the whole channel)");
  assert.deepEqual(parseDeliveryTarget(cands[1]!.target), { channel: "C123" });
  assert.notEqual(cands[0]!.target, cands[1]!.target);
});

test("deliveryCandidatesFor: a DM has a single destination → no menu", () => {
  assert.equal(deliveryCandidatesFor("dm", "D1", "1.2", undefined), undefined);
});

test("deliveryCandidatesFor: missing channel name falls back to a generic label", () => {
  const cands = deliveryCandidatesFor("channel", "C7", undefined, undefined);
  assert.ok(cands);
  assert.equal(cands[1]!.label, "the whole channel");
});

test("deliveryCandidatesFor: a group DM offers this-thread and group-DM destinations", () => {
  const cands = deliveryCandidatesFor("group", "G123", "1699999999.001200", undefined);
  assert.ok(cands);
  assert.deepEqual(cands[0], { target: "G123:1699999999.001200", label: "this thread" });
  assert.deepEqual(cands[1], { target: "G123", label: "the group DM" });
});

interface DeliveryLogEntry {
  stage: "post" | "ack";
  gaveUp: boolean;
}

function deliveryHarness(opts: { postFails?: number; ackFails?: number; maxAttempts?: number } = {}) {
  const tracker = createDeliveryTracker({ maxAttempts: opts.maxAttempts ?? 5 });
  let postFails = opts.postFails ?? 0;
  let ackFails = opts.ackFails ?? 0;
  const posts: number[] = [];
  const acks: unknown[] = [];
  const errors: DeliveryLogEntry[] = [];
  const cycle = async (ackBody?: unknown): Promise<void> =>
    deliverWithRetry({
      tracker,
      id: "d1",
      post: async () => {
        if (postFails > 0) {
          postFails--;
          throw new Error("slack 429");
        }
        posts.push(1);
        return ackBody;
      },
      ack: async (body) => {
        if (ackFails > 0) {
          ackFails--;
          throw new Error("core 503");
        }
        acks.push(body);
      },
      onError: (stage, _err, gaveUp) => errors.push({ stage, gaveUp }),
    });
  return { tracker, cycle, posts, acks, errors };
}

test("deliverWithRetry: happy path posts once, acks once, and clears its state", async () => {
  const h = deliveryHarness();
  await h.cycle({ recipientThreadRef: "dm:D1" });
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.acks, [{ recipientThreadRef: "dm:D1" }]);
  assert.deepEqual(h.errors, []);
});

test("deliverWithRetry: a failed ack does NOT re-post on the next cycle — only the ack retries (no duplicate message)", async () => {
  const h = deliveryHarness({ ackFails: 1 });
  await h.cycle({ recipientThreadRef: "dm:D1" });
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.errors, [{ stage: "ack", gaveUp: false }]);

  await h.cycle();
  assert.equal(h.posts.length, 1, "message was already posted — never duplicated");
  assert.deepEqual(h.acks, [{ recipientThreadRef: "dm:D1" }], "the original ack body is retried");
});

test("deliverWithRetry: a poison delivery is given up on after the attempt cap, then skipped for free", async () => {
  const h = deliveryHarness({ postFails: 100, maxAttempts: 3 });
  for (let i = 0; i < 5; i++) await h.cycle();
  assert.equal(h.posts.length, 0);
  assert.deepEqual(h.errors, [
    { stage: "post", gaveUp: false },
    { stage: "post", gaveUp: false },
    { stage: "post", gaveUp: true },
  ]);
  assert.ok(h.tracker.givenUp("d1"), "later cycles skip the poison delivery without attempting it");
});

test("deliverWithRetry: transient post failures recover before the cap", async () => {
  const h = deliveryHarness({ postFails: 2, maxAttempts: 5 });
  for (let i = 0; i < 3; i++) await h.cycle();
  assert.equal(h.posts.length, 1);
  assert.equal(h.acks.length, 1);
  assert.ok(!h.tracker.givenUp("d1"));
});

test("createDeliveryTracker: a posted-but-unacked entry evicted by the cap is given up on, never re-posted", () => {
  const t = createDeliveryTracker({ maxAttempts: 5, maxTracked: 2 });
  t.markPosted("a");
  t.markPosted("b");
  t.markPosted("c");
  assert.equal(t.posted("a"), undefined);
  assert.ok(t.givenUp("a"), "evicted posted entry becomes dead — duplicate post is impossible");
  assert.ok(t.posted("b") && t.posted("c"), "entries within the cap keep their posted state");
});

const WEB_BASE = "https://portal.example.com/web-ui";
const BOT = "UBOT";

function fakeJoinClient(
  opts: {
    postMessageFails?: boolean;
    extShared?: boolean;
  } = {},
) {
  const calls = {
    posted: [] as Array<{ channel: string; text: string }>,
    order: [] as string[],
  };
  return {
    calls,
    client: {
      chat: {
        postMessage: async (args: { channel: string; text: string }) => {
          calls.order.push("post");
          if (opts.postMessageFails) {
            const err = new Error("ratelimited") as Error & { data?: unknown };
            err.data = { error: "ratelimited" };
            throw err;
          }
          calls.posted.push({ channel: args.channel, text: args.text });
          return {};
        },
      },
      conversations: {
        info: async (_args: { channel: string }) => ({
          channel: { is_ext_shared: Boolean(opts.extShared) },
        }),
      },
    },
  };
}

test("channelSurfaceUrl builds the project deep link and degrades when unset", () => {
  assert.equal(channelSurfaceUrl(WEB_BASE, "C123"), `${WEB_BASE}/projects/channel/C123`);
  assert.equal(channelSurfaceUrl("https://x/web-ui/", "C9"), "https://x/web-ui/projects/channel/C9");
  assert.equal(channelSurfaceUrl(undefined, "C1"), undefined);
  assert.equal(channelSurfaceUrl("", "C1"), undefined);
});

test("channelWelcomeMessage includes the link when present, omits it cleanly when not", () => {
  const url = channelSurfaceUrl(WEB_BASE, "C1")!;
  assert.ok(channelWelcomeMessage(url).includes(url));
  const linkless = channelWelcomeMessage(undefined);
  assert.ok(!linkless.includes("http"));
  assert.ok(linkless.length > 0);
});

test("onBotJoinedChannel: syncs the directory before posting, so the link it advertises already resolves", async () => {
  const { client, calls } = fakeJoinClient();
  let synced = 0;
  await onBotJoinedChannel({
    client,
    channel: "C123",
    joinerUserId: BOT,
    botUserId: BOT,
    webUiPublicUrl: WEB_BASE,
    syncDirectory: async () => {
      synced++;
      calls.order.push("sync");
    },
  });
  const expectedUrl = `${WEB_BASE}/projects/channel/C123`;
  assert.equal(calls.posted.length, 1);
  assert.equal(calls.posted[0]!.channel, "C123");
  assert.ok(calls.posted[0]!.text.includes(expectedUrl), "welcome message must contain the channel surface deep link");
  assert.equal(synced, 1, "directory sync must run on bot join");
  assert.deepEqual(calls.order, ["sync", "post"], "the channel must be in the directory before its link is advertised");
});

test("onBotJoinedChannel: a sync failure still posts the welcome", async () => {
  const { client, calls } = fakeJoinClient();
  await assert.doesNotReject(
    onBotJoinedChannel({
      client,
      channel: "C123",
      joinerUserId: BOT,
      botUserId: BOT,
      webUiPublicUrl: WEB_BASE,
      syncDirectory: async () => {
        throw new Error("core unreachable");
      },
    }),
  );
  assert.equal(calls.posted.length, 1, "a failed sync must not swallow the welcome");
});

test("onBotJoinedChannel: ignores a human joining (only the bot itself triggers it)", async () => {
  const { client, calls } = fakeJoinClient();
  let synced = 0;
  await onBotJoinedChannel({
    client,
    channel: "C123",
    joinerUserId: "UHUMAN",
    botUserId: BOT,
    webUiPublicUrl: WEB_BASE,
    syncDirectory: async () => {
      synced++;
    },
  });
  assert.equal(calls.posted.length, 0);
  assert.equal(synced, 0);
});

test("onBotJoinedChannel: a welcome-post failure still leaves the directory synced", async () => {
  const { client, calls } = fakeJoinClient({ postMessageFails: true });
  let synced = 0;
  await assert.doesNotReject(
    onBotJoinedChannel({
      client,
      channel: "C123",
      joinerUserId: BOT,
      botUserId: BOT,
      webUiPublicUrl: WEB_BASE,
      syncDirectory: async () => {
        synced++;
      },
    }),
  );
  assert.equal(calls.posted.length, 0, "the welcome post threw");
  assert.equal(synced, 1, "directory sync ran so members can reach the surface even if the welcome failed");
});

test("onBotJoinedChannel: stays silent in an externally-shared (Slack Connect) channel", async () => {
  const { client, calls } = fakeJoinClient({ extShared: true });
  let synced = 0;
  await onBotJoinedChannel({
    client,
    channel: "C123",
    joinerUserId: BOT,
    botUserId: BOT,
    webUiPublicUrl: WEB_BASE,
    syncDirectory: async () => {
      synced++;
    },
  });
  assert.equal(calls.posted.length, 0, "the bot never posts into a Connect channel (an external could see it)");
  assert.equal(synced, 1, "directory sync (which never emits into the channel) still runs");
});

test("onBotJoinedChannel: never writes the channel's description or topic", async () => {
  const { client, calls } = fakeJoinClient();
  const forbidden = { setPurpose: 0, setTopic: 0 };
  const guarded = {
    ...client,
    conversations: {
      ...client.conversations,
      setPurpose: async () => {
        forbidden.setPurpose++;
        return {};
      },
      setTopic: async () => {
        forbidden.setTopic++;
        return {};
      },
    },
  };
  await onBotJoinedChannel({
    client: guarded,
    channel: "C123",
    joinerUserId: BOT,
    botUserId: BOT,
    webUiPublicUrl: WEB_BASE,
    syncDirectory: async () => {},
  });
  assert.equal(calls.posted.length, 1, "the welcome is the only thing the join writes");
  assert.deepEqual(forbidden, { setPurpose: 0, setTopic: 0 }, "a joined channel keeps whatever description it had");
});

function verifyHarness(
  opts: {
    postResults?: Array<{ ok?: { ts: string; channel?: string }; err?: unknown }>;
    historyMessages?: unknown[];
    historyThrows?: boolean;
  } = {},
) {
  const results = opts.postResults ?? [{ ok: { ts: "1.1", channel: "C1" } }];
  let postCall = 0;
  const postArgs: any[] = [];
  let historyArgs: any;
  let repliesArgs: any;
  const scan = async () => {
    if (opts.historyThrows) throw new Error("history read failed");
    return { messages: opts.historyMessages ?? [] };
  };
  const client = {
    chat: {
      postMessage: async (args: any) => {
        postArgs.push(args);
        const r = results[Math.min(postCall, results.length - 1)]!;
        postCall++;
        if (r.err) throw r.err;
        return r.ok;
      },
    },
    conversations: {
      history: async (args: any) => {
        historyArgs = args;
        return scan();
      },
      replies: async (args: any) => {
        repliesArgs = args;
        return scan();
      },
    },
  } as any;
  return {
    client,
    postArgs,
    get postCalls() {
      return postArgs.length;
    },
    get historyCalled() {
      return historyArgs !== undefined;
    },
    get repliesCalled() {
      return repliesArgs !== undefined;
    },
  };
}

const KEY = "run:abc";
const foundMsg = { ts: "9.9", metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: KEY } } };

test("postWithVerify: posts once and returns ts on success", async () => {
  const h = verifyHarness();
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.deepEqual(res, { ts: "1.1", channel: "C1" });
  assert.equal(h.postCalls, 1);
  assert.equal(h.historyCalled, false, "no verify on a clean success");
});

test("postWithVerify: stamps metadata with the idempotency key", async () => {
  const h = verifyHarness();
  await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.deepEqual(h.postArgs[0].metadata, {
    event_type: "qm_delivery",
    event_payload: { idempotency_key: KEY },
  });
});

test("postWithVerify: platform error rethrows without retry", async () => {
  const err = { code: "slack_webapi_platform_error", data: { error: "channel_not_found" } };
  const h = verifyHarness({ postResults: [{ err }] });
  await assert.rejects(
    () => postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY),
    (e: any) => e === err,
  );
  assert.equal(h.postCalls, 1);
  assert.equal(h.historyCalled, false);
});

test("postWithVerify: rate limit retries without verify", async () => {
  const h = verifyHarness({
    postResults: [
      { err: { code: "slack_webapi_rate_limited_error", retryAfter: 0 } },
      { ok: { ts: "2.2", channel: "C1" } },
    ],
  });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.equal(res.ts, "2.2");
  assert.equal(h.postCalls, 2);
  assert.equal(h.historyCalled, false, "a 429 didn't execute — no verify needed");
});

test("postWithVerify: ambiguous error + message found on verify returns existing ts, no re-post", async () => {
  const h = verifyHarness({
    postResults: [{ err: { code: "slack_webapi_request_error", original: { code: "ETIMEDOUT" } } }],
    historyMessages: [foundMsg],
  });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.deepEqual(res, { ts: "9.9", channel: "C1" });
  assert.equal(h.postCalls, 1, "the post landed — never re-sent");
  assert.equal(h.historyCalled, true);
});

test("postWithVerify: recovery preflight returns an existing keyed post without posting again", async () => {
  const h = verifyHarness({ historyMessages: [foundMsg] });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY, { verifyFirst: true });
  assert.deepEqual(res, { ts: "9.9", channel: "C1" });
  assert.equal(h.postCalls, 0, "fresh-process recovery reuses the live post");
  assert.equal(h.historyCalled, true);
});

test("postWithVerify: threaded recovery paginates within the delivery window before posting", async () => {
  let replyReads = 0;
  const client = {
    chat: { postMessage: async () => assert.fail("an existing recovery post must not be posted again") },
    conversations: {
      history: async () => assert.fail("thread recovery must read replies"),
      replies: async () => {
        replyReads++;
        return replyReads === 1
          ? { messages: [], response_metadata: { next_cursor: "next" } }
          : { messages: [foundMsg], response_metadata: { next_cursor: "" } };
      },
    },
  } as any;
  const res = await postWithVerify(client, { channel: "C1", text: "hi", thread_ts: "5.5" }, KEY, {
    verifyFirst: true,
    verifyOldest: "100.0",
  });
  assert.deepEqual(res, { ts: "9.9", channel: "C1" });
  assert.equal(replyReads, 2);
});

test("postWithVerify: ambiguous error + not found retries the post", async () => {
  const h = verifyHarness({
    postResults: [
      { err: { code: "slack_webapi_request_error", original: { code: "ECONNRESET" } } },
      { ok: { ts: "3.3", channel: "C1" } },
    ],
    historyMessages: [],
  });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.equal(res.ts, "3.3");
  assert.equal(h.postCalls, 2);
});

test("postWithVerify: ambiguous error + verify read fails rethrows without re-post", async () => {
  const err = { code: "slack_webapi_request_error", original: { code: "ETIMEDOUT" } };
  const h = verifyHarness({ postResults: [{ err }], historyThrows: true });
  await assert.rejects(
    () => postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY),
    (e: any) => e === err,
  );
  assert.equal(h.postCalls, 1, "at-most-once: never re-sent when we can't confirm");
});

test("postWithVerify: threaded post verifies via conversations.replies", async () => {
  const h = verifyHarness({
    postResults: [{ err: { code: "slack_webapi_request_error", original: { code: "ETIMEDOUT" } } }],
    historyMessages: [foundMsg],
  });
  await postWithVerify(h.client, { channel: "C1", text: "hi", thread_ts: "5.5" } as any, KEY);
  assert.equal(h.repliesCalled, true);
  assert.equal(h.historyCalled, false, "threaded verify reads replies, not history");
});
