import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";
import { createThreadTracker } from "../src/slack/lib.ts";

test("recovered top-level DM attachments stay top-level", async () => {
  const uploads: any[] = [];
  const posts: any[] = [];
  const deliveries = [
    {
      id: "delivery-edit",
      idempotencyKey: "run:R1",
      destination: { type: "slack", target: "D1", editRef: "posted-1" },
      text: "edited answer",
      attachments: [{ blobId: "blob-1", name: "edited.txt", sizeBytes: 2 }],
    },
    {
      id: "delivery-post",
      idempotencyKey: "run:R2",
      destination: { type: "slack", target: "D1" },
      text: "posted answer",
      attachments: [{ blobId: "blob-2", name: "posted.txt", sizeBytes: 2 }],
    },
  ];
  let claimed = false;
  const client = {
    chat: {
      update: async () => ({ ok: true }),
      postMessage: async (body: any) => {
        posts.push(body);
        return { ok: true, ts: "posted-2", channel: body.channel };
      },
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
    },
    files: {
      uploadV2: async (body: any) => {
        uploads.push(body);
        return { ok: true };
      },
      info: async () => ({ file: {} }),
    },
  };
  const poller = createDeliveryPoller({
    core: {
      claimDeliveries: async (type: string) => {
        if (type !== "slack" || claimed) return [];
        claimed = true;
        return deliveries;
      },
      ackDelivery: async () => {},
    } as any,
    bridge: {
      inFlightRuns: new Set<string>(),
      fetchBlobFromCore: async () => Buffer.from("ok"),
      fetchFileArtifactFromCore: async () => Buffer.from("ok"),
    } as any,
    mirror: { mirrorSelfPost: () => {} } as any,
    threads: createThreadTracker(),
    clientForIdentity: () => client,
  });

  await poller.pollDeliveries(client);

  assert.equal(posts.length, 1);
  assert.deepEqual(
    uploads.map(({ channel_id, thread_ts, filename }) => ({ channel_id, thread_ts, filename })),
    [
      { channel_id: "D1", thread_ts: undefined, filename: "edited.txt" },
      { channel_id: "D1", thread_ts: undefined, filename: "posted.txt" },
    ],
  );
});

test("unfinished stream recovery replaces a possibly finalized message without updating it", async () => {
  const deletes: any[] = [];
  const posts: any[] = [];
  let claimed = false;
  const client = {
    chat: {
      delete: async (body: any) => void deletes.push(body),
      postMessage: async (body: any) => {
        posts.push(body);
        return { ok: true, ts: "300.3" };
      },
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
    },
  };
  const poller = createDeliveryPoller({
    core: {
      claimDeliveries: async (type: string) => {
        if (type !== "slack" || claimed) return [];
        claimed = true;
        return [
          {
            id: "delivery-stream",
            idempotencyKey: "run:R1",
            destination: {
              type: "slack",
              target: "D1:100.1",
              stream: { channel: "D1", ts: "200.2", unfinished: true },
            },
            text: "authoritative answer",
          },
        ];
      },
      ackDelivery: async () => {},
    } as any,
    bridge: { inFlightRuns: new Set<string>() } as any,
    mirror: { mirrorSelfPost: () => {} } as any,
    threads: createThreadTracker(),
    clientForIdentity: () => client,
  });

  await poller.pollDeliveries(client);

  assert.deepEqual(deletes, [{ channel: "D1", ts: "200.2" }]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, "authoritative answer");
  assert.equal((posts[0].blocks as any[]).at(-1)?.type, "context_actions");
});

test("unfinished stream recovery replaces a stopped draft with the authoritative surface", async () => {
  const deletes: any[] = [];
  const posts: any[] = [];
  let claimed = false;
  const client = {
    chat: {
      delete: async (body: any) => void deletes.push(body),
      postMessage: async (body: any) => {
        posts.push(body);
        return { ok: true, ts: "300.3" };
      },
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
    },
  };
  const poller = createDeliveryPoller({
    core: {
      claimDeliveries: async (type: string) => {
        if (type !== "slack" || claimed) return [];
        claimed = true;
        return [
          {
            id: "delivery-stream",
            idempotencyKey: "run:R1",
            destination: {
              type: "slack",
              target: "D1:100.1",
              stream: { channel: "D1", ts: "200.2", unfinished: true },
              taskList: [{ id: "task-1", title: "Search", status: "completed" }],
            },
            text: "authoritative answer",
          },
        ];
      },
      ackDelivery: async () => {},
    } as any,
    bridge: { inFlightRuns: new Set<string>() } as any,
    mirror: { mirrorSelfPost: () => {} } as any,
    threads: createThreadTracker(),
    clientForIdentity: () => client,
  });

  await poller.pollDeliveries(client);

  assert.deepEqual(deletes, [{ channel: "D1", ts: "200.2" }]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, "authoritative answer");
  assert.equal(JSON.stringify(posts[0].blocks).includes("Search"), true);
  assert.equal((posts[0].blocks as any[]).at(-1)?.type, "context_actions");
});

test("completed attachments-only streams keep their message during recovery", async () => {
  const deleted: any[] = [];
  const uploads: any[] = [];
  let claimed = false;
  const client = {
    chat: {
      delete: async (body: any) => void deleted.push(body),
    },
    files: {
      uploadV2: async (body: any) => {
        uploads.push(body);
        return { ok: true };
      },
      info: async () => ({ file: {} }),
    },
  };
  const poller = createDeliveryPoller({
    core: {
      claimDeliveries: async (type: string) => {
        if (type !== "slack" || claimed) return [];
        claimed = true;
        return [
          {
            id: "delivery-stream",
            idempotencyKey: "run:R1",
            destination: { type: "slack", target: "D1:100.1", editRef: "200.2", preserveMessage: true },
            text: "",
            attachments: [{ blobId: "blob-1", name: "report.txt", sizeBytes: 2 }],
          },
        ];
      },
      ackDelivery: async () => {},
    } as any,
    bridge: {
      inFlightRuns: new Set<string>(),
      fetchBlobFromCore: async () => Buffer.from("ok"),
      fetchFileArtifactFromCore: async () => Buffer.from("ok"),
    } as any,
    mirror: { mirrorSelfPost: () => {} } as any,
    threads: createThreadTracker(),
    clientForIdentity: () => client,
  });

  await poller.pollDeliveries(client);

  assert.deepEqual(deleted, []);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].thread_ts, "100.1");
});
