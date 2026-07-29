import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { createBrainMemoryService, sourceForScope, type BrainFetch } from "../src/memory/brain-memory-service.ts";
import { createBrainMcp } from "../src/memory/brain-mcp.ts";
import { createBrainClientStore, type BrainClient } from "../src/memory/brain-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { scopeId, type ScopeId } from "../src/types.ts";

interface FakeClient {
  source: string;
  federated_read: string[];
}

interface McpCall {
  kind: "token" | "mcp";
  tool?: string;
  source?: string;
  args?: Record<string, unknown>;
  clientId?: string;
}

function fakeBrain(
  clients: Record<string, FakeClient>,
  opts: { failNetwork?: boolean; tokenExpiresIn?: number; seed?: Record<string, string[]>; now?: () => number } = {},
) {
  const calls: McpCall[] = [];
  const tokenToClient = new Map<string, string>();
  const data: Record<string, string[]> = { ...opts.seed };
  let mints = 0;
  const resp = (obj: unknown) => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(obj);
    },
  });

  const fetchImpl: BrainFetch = async (url, init) => {
    if (opts.failNetwork) throw new Error("ECONNREFUSED");
    if (url.endsWith("/token")) {
      const cid = new URLSearchParams(init.body).get("client_id") ?? "";
      mints++;
      const tok = `tok-${cid}-${mints}`;
      tokenToClient.set(tok, cid);
      calls.push({ kind: "token", clientId: cid });
      return resp({ access_token: tok, expires_in: opts.tokenExpiresIn ?? 3600 });
    }
    const cid = tokenToClient.get((init.headers.authorization ?? "").replace(/^Bearer /, ""));
    const client = cid ? clients[cid] : undefined;
    const body = JSON.parse(init.body) as { params: { name: string; arguments?: Record<string, unknown> } };
    const name = body.params.name;
    const args = body.params.arguments ?? {};
    const source = typeof args.source === "string" ? args.source : undefined;
    calls.push({ kind: "mcp", tool: name, ...(source ? { source } : {}), args, ...(cid ? { clientId: cid } : {}) });
    if (!client) return resp({ error: { message: "invalid token" } });
    if (name === "whoami")
      return resp({
        result: { structuredContent: { source_id: client.source, federated_read: client.federated_read } },
      });
    if (name === "extract_facts") {
      if (source !== client.source) return resp({ result: { structuredContent: { count: 0 } } });
      const lines = String(args.text ?? "")
        .split("\n")
        .filter(Boolean);
      (data[source] ??= []).push(...lines);
      return resp({ result: { structuredContent: { count: lines.length } } });
    }
    if (name === "recall") {
      if (!source || !client.federated_read.includes(source))
        return resp({ result: { content: [{ type: "text", text: "" }] } });
      return resp({
        result: { content: [{ type: "text", text: (data[source] ?? []).map((f) => `- ${f}`).join("\n") }] },
      });
    }
    const q = String(args.query ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const facts = client.federated_read.flatMap((s) => data[s] ?? []);
    const text = facts.filter((f) => q.every((t) => f.toLowerCase().includes(t))).join("\n");
    return resp({ result: { content: [{ type: "text", text }] } });
  };

  return {
    fetchImpl,
    calls,
    data,
    get mints() {
      return mints;
    },
  };
}

const MCP_URL = "https://brain.acme.test";

function setup(
  scope: ScopeId,
  override: Partial<BrainClient> = {},
  fakeOpts: Parameters<typeof fakeBrain>[1] = {},
  serviceOpts: { compose?: boolean } = { compose: true },
) {
  const src = sourceForScope(scope);
  const clientId = `c-${src}`;
  const client: BrainClient = {
    clientId,
    clientSecret: "s3cr3t-shhh",
    source: src,
    federatedRead: [src, "shared"],
    ...override,
  };
  const fakeClients: Record<string, FakeClient> = {
    [clientId]: { source: client.source, federated_read: client.federatedRead },
  };
  const fake = fakeBrain(fakeClients, fakeOpts);
  const store = createBrainClientStore(createMemoryMap<BrainClient>());
  store.set(scope, client);
  const audit = createAuditLog();
  const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "gb-")));
  const fallback = serviceOpts.compose ? createMemoryService(ws) : undefined;
  const brain = createBrainMemoryService({
    mcpUrl: MCP_URL,
    clients: store,
    sharedSource: "shared",
    ...(fallback ? { fallback } : {}),
    audit,
    fetchImpl: fake.fetchImpl,
  });
  return { brain, fake, store, audit, ws, scope, src, clientId, client };
}

test("scope maps to a valid lowercase brain source id, distinct per scope", () => {
  assert.equal(sourceForScope(scopeId("personal", "U1")), "personal-u1");
  assert.equal(sourceForScope(scopeId("channel", "C1")), "channel-c1");
  assert.match(sourceForScope(scopeId("personal", "U1")), /^[a-z0-9-]{1,32}$/);
  assert.notEqual(sourceForScope(scopeId("personal", "U1")), sourceForScope(scopeId("channel", "C1")));
});

test("capture writes facts to the scope's source AND writes through to the notebook", async () => {
  const { brain, fake, ws, scope, src } = setup(scopeId("personal", "U1"));
  const added = await brain.capture(scope, ["X handle is be17832773", "Prefers terse replies"], Date.UTC(2026, 4, 31));
  assert.equal(added, 2);
  const extract = fake.calls.find((c) => c.tool === "extract_facts");
  assert.equal(extract?.source, src);
  assert.deepEqual(fake.data[src], ["X handle is be17832773", "Prefers terse replies"]);
  assert.match((await ws.read(scope, "memory/MEMORY.md")) ?? "", /be17832773/);
});

test("recall combines the notebook continuity floor with brain facts, source-scoped", async () => {
  const { brain, fake, scope, src } = setup(
    scopeId("personal", "U1"),
    {},
    { seed: { "personal-u1": ["Loves espresso"] } },
  );
  await brain.capture(scope, ["Notebook-only note"], Date.UTC(2026, 4, 31));
  const text = await brain.recall(scope);
  assert.match(text, /Notebook-only note/);
  assert.match(text, /Loves espresso/);
  const recall = fake.calls.find((c) => c.tool === "recall");
  assert.equal(recall?.source, src);
});

test("read/replace target the editable notebook substrate (compose mode); capture still composes", async () => {
  const { brain, fake, ws, scope, src } = setup(
    scopeId("personal", "U1"),
    {},
    { seed: { "personal-u1": ["Loves espresso"] } },
  );

  await brain.replace(scope, "# Memory\n\n- I work in PT");
  assert.equal(await brain.read(scope), "# Memory\n\n- I work in PT\n", "read/replace round-trip through the notebook");
  assert.equal(
    (await ws.read(scope, "memory/MEMORY.md")) ?? "",
    "# Memory\n\n- I work in PT\n",
    "the write landed in the local notebook",
  );
  assert.equal(fake.calls.filter((c) => c.tool === "extract_facts").length, 0, "replace never writes the remote brain");

  const text = await brain.recall(scope);
  assert.match(text, /I work in PT/, "edited notebook content is recalled");
  assert.match(text, /Loves espresso/, "remote brain facts still compose in");
  assert.equal(fake.calls.find((c) => c.tool === "recall")?.source, src);
});

test('with NO notebook fallback, read()→"" and replace() is a no-op (no MCP call)', async () => {
  const { brain, fake, scope } = setup(scopeId("personal", "U1"), {}, {}, { compose: false });
  assert.equal(await brain.read(scope), "", "brain-only deployment has nothing to hand-edit");
  await brain.replace(scope, "# Memory\n\n- ignored");
  assert.equal(await brain.read(scope), "", "replace is a no-op without a notebook");
  assert.equal(fake.calls.length, 0, "read/replace never touch the remote brain");
});

test("query routes to search across federated_read (own + shared), returns matching lines", async () => {
  const { brain, fake, scope } = setup(
    scopeId("personal", "U1"),
    {},
    { seed: { "personal-u1": ["X handle is be17832773", "Prefers terse"], shared: ["Org wifi is acme-guest"] } },
  );
  assert.deepEqual(await brain.query(scope, "handle"), ["X handle is be17832773"]);
  assert.deepEqual(await brain.query(scope, "wifi"), ["Org wifi is acme-guest"]);
  const search = fake.calls.find((c) => c.tool === "search");
  assert.equal(search?.source, undefined, "search is not pinned to one source — scoping is the token's federated_read");
});

test("token is minted once and reused across ops; re-minted after expiry", async () => {
  let clock = 1_000_000;
  const scope = scopeId("personal", "U1");
  const src = sourceForScope(scope);
  const store = createBrainClientStore(createMemoryMap<BrainClient>());
  store.set(scope, { clientId: `c-${src}`, clientSecret: "x", source: src, federatedRead: [src, "shared"] });
  const fake = fakeBrain({ [`c-${src}`]: { source: src, federated_read: [src, "shared"] } }, { tokenExpiresIn: 100 });
  const brain = createBrainMemoryService({
    mcpUrl: MCP_URL,
    clients: store,
    fetchImpl: fake.fetchImpl,
    now: () => clock,
  });
  await brain.recall(scope);
  await brain.query(scope, "x");
  assert.equal(fake.mints, 1, "token cached across ops within its lifetime");
  clock += 200_000;
  await brain.recall(scope);
  assert.equal(fake.mints, 2, "token re-minted after expiry");
});

test("no client for the scope → degrade: notebook recall, empty query, no MCP calls", async () => {
  const store = createBrainClientStore(createMemoryMap<BrainClient>());
  const fake = fakeBrain({});
  const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "gb-")));
  const fallback = createMemoryService(ws);
  const scope = scopeId("personal", "U9");
  const brain = createBrainMemoryService({ mcpUrl: MCP_URL, clients: store, fallback, fetchImpl: fake.fetchImpl });
  const added = await brain.capture(scope, ["only in notebook"], Date.UTC(2026, 4, 31));
  assert.equal(added, 1);
  assert.match(await brain.recall(scope), /only in notebook/);
  assert.deepEqual(await brain.query(scope, "notebook"), []);
  assert.equal(fake.mints, 0, "never mint a token or hit the brain without a provisioned client");
});

test("a client whose federated_read names another principal's source fails closed (static)", async () => {
  const scope = scopeId("personal", "U1");
  const { brain, fake, audit } = setup(scope, { federatedRead: ["personal-u1", "personal-u2", "shared"] });
  assert.deepEqual(await brain.query(scope, "anything"), []);
  assert.equal(fake.mints, 0, "no token minted for a misconfigured client");
  assert.ok((await audit.events()).some((e) => e.action === "brain.resolve" && e.status === "scope_mismatch"));
});

test("whoami disagreement (server-side mis-scope) fails closed and audits", async () => {
  const scope = scopeId("personal", "U1");
  const src = sourceForScope(scope);
  const store = createBrainClientStore(createMemoryMap<BrainClient>());
  store.set(scope, { clientId: "c-bad", clientSecret: "x", source: src, federatedRead: [src, "shared"] });
  const fake = fakeBrain({ "c-bad": { source: "personal-u2", federated_read: ["personal-u2", "shared"] } });
  const audit = createAuditLog();
  const brain = createBrainMemoryService({ mcpUrl: MCP_URL, clients: store, audit, fetchImpl: fake.fetchImpl });
  assert.deepEqual(await brain.query(scope, "x"), []);
  assert.ok((await audit.events()).some((e) => e.action === "brain.whoami" && e.status === "scope_mismatch"));
  assert.ok(!fake.calls.some((c) => c.tool === "search"));
});

test("a re-provisioned corrected client clears the cached whoami verdict and re-probes (recovers without restart)", async () => {
  const scope = scopeId("personal", "U1");
  const src = sourceForScope(scope);
  const store = createBrainClientStore(createMemoryMap<BrainClient>());
  store.set(scope, { clientId: "c-bad", clientSecret: "x", source: src, federatedRead: [src, "shared"] });
  const fake = fakeBrain({
    "c-bad": { source: "personal-u2", federated_read: ["personal-u2", "shared"] },
    "c-good": { source: src, federated_read: [src, "shared"] },
  });
  const brain = createBrainMemoryService({ mcpUrl: MCP_URL, clients: store, fetchImpl: fake.fetchImpl });

  assert.deepEqual(await brain.query(scope, "x"), []);
  assert.deepEqual(await brain.query(scope, "x"), []);
  assert.equal(
    fake.calls.filter((c) => c.tool === "whoami").length,
    1,
    "the false verdict is cached — no re-probe for the bad client",
  );

  fake.data[src] = ["X handle is be17832773"];
  await store.set(scope, { clientId: "c-good", clientSecret: "y", source: src, federatedRead: [src, "shared"] });

  assert.deepEqual(await brain.query(scope, "handle"), ["X handle is be17832773"]);
  assert.equal(
    fake.calls.filter((c) => c.tool === "whoami").length,
    2,
    "the corrected client re-probed whoami after re-provision",
  );
});

test("a same-clientId re-provision (secret rotation) evicts the cached token and re-mints with the new secret", async () => {
  const scope = scopeId("personal", "U1");
  const src = sourceForScope(scope);
  const clientId = `c-${src}`;
  let currentSecret = "secret-v1";
  const tokenToSecret = new Map<string, string>();
  let mints = 0;
  let whoamis = 0;
  const resp = (obj: unknown) => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(obj);
    },
  });

  const fetchImpl: BrainFetch = async (url, init) => {
    if (url.endsWith("/token")) {
      const params = new URLSearchParams(init.body);
      const secret = params.get("client_secret") ?? "";
      if (secret !== currentSecret)
        return {
          ok: false,
          status: 401,
          async text() {
            return "bad secret";
          },
        };
      mints++;
      const tok = `tok-${mints}`;
      tokenToSecret.set(tok, secret);
      return resp({ access_token: tok, expires_in: 3600 });
    }
    const tok = (init.headers.authorization ?? "").replace(/^Bearer /, "");
    if (tokenToSecret.get(tok) !== currentSecret) return resp({ error: { message: "invalid token" } });
    const body = JSON.parse(init.body) as { params: { name: string; arguments?: Record<string, unknown> } };
    const name = body.params.name;
    if (name === "whoami") {
      whoamis++;
      return resp({ result: { structuredContent: { source_id: src, federated_read: [src, "shared"] } } });
    }
    if (name === "search" || name === "think") {
      const q = String(body.params.arguments?.query ?? "").toLowerCase();
      return resp({
        result: { content: [{ type: "text", text: q.includes("handle") ? "X handle is be17832773" : "" }] },
      });
    }
    return resp({ result: { content: [{ type: "text", text: "" }] } });
  };

  const store = createBrainClientStore(createMemoryMap<BrainClient>());
  await store.set(scope, { clientId, clientSecret: currentSecret, source: src, federatedRead: [src, "shared"] });
  const brain = createBrainMemoryService({ mcpUrl: MCP_URL, clients: store, fetchImpl });

  assert.deepEqual(await brain.query(scope, "handle"), ["X handle is be17832773"]);
  assert.deepEqual(await brain.query(scope, "handle"), ["X handle is be17832773"]);
  assert.equal(mints, 1, "token cached across ops");
  assert.equal(whoamis, 1, "whoami verdict cached across ops");

  currentSecret = "secret-v2";
  await store.set(scope, { clientId, clientSecret: currentSecret, source: src, federatedRead: [src, "shared"] });

  assert.deepEqual(await brain.query(scope, "handle"), ["X handle is be17832773"]);
  assert.equal(mints, 2, "the rotated secret forced a fresh token mint (cached token was evicted)");
});

test("the whoami verdict cache expires on a TTL — a brain fixed out-of-band (another instance) recovers without a local re-provision", async () => {
  let clock = 1_000_000;
  const scope = scopeId("personal", "U1");
  const src = sourceForScope(scope);
  const store = createBrainClientStore(createMemoryMap<BrainClient>());
  store.set(scope, { clientId: "c-flaky", clientSecret: "x", source: src, federatedRead: [src, "shared"] });
  const fakeClients: Record<string, FakeClient> = {
    "c-flaky": { source: "personal-u2", federated_read: ["personal-u2", "shared"] },
  };
  const fake = fakeBrain(fakeClients);
  const brain = createBrainMemoryService({
    mcpUrl: MCP_URL,
    clients: store,
    fetchImpl: fake.fetchImpl,
    now: () => clock,
    verifyTtlMs: 60_000,
  });

  assert.deepEqual(await brain.query(scope, "handle"), []);
  assert.deepEqual(await brain.query(scope, "handle"), []);
  assert.equal(
    fake.calls.filter((c) => c.tool === "whoami").length,
    1,
    "within the TTL the negative verdict is cached",
  );

  fakeClients["c-flaky"] = { source: src, federated_read: [src, "shared"] };
  fake.data[src] = ["X handle is be17832773"];

  clock += 61_000;
  assert.deepEqual(
    await brain.query(scope, "handle"),
    ["X handle is be17832773"],
    "expired verdict re-probed and recovered",
  );
  assert.equal(fake.calls.filter((c) => c.tool === "whoami").length, 2, "whoami re-probed after the TTL");

  await brain.query(scope, "handle");
  assert.equal(fake.calls.filter((c) => c.tool === "whoami").length, 2, "a fresh positive verdict is cached again");
  clock += 61_000;
  await brain.query(scope, "handle");
  assert.equal(
    fake.calls.filter((c) => c.tool === "whoami").length,
    3,
    "positive verdicts also re-verify after the TTL",
  );
});

test("network failure degrades cleanly: notebook recall, empty query, notebook capture", async () => {
  const scope = scopeId("personal", "U1");
  const src = sourceForScope(scope);
  const store = createBrainClientStore(createMemoryMap<BrainClient>());
  store.set(scope, { clientId: `c-${src}`, clientSecret: "x", source: src, federatedRead: [src, "shared"] });
  const fake = fakeBrain({ [`c-${src}`]: { source: src, federated_read: [src, "shared"] } }, { failNetwork: true });
  const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "gb-")));
  const fallback = createMemoryService(ws);
  const brain = createBrainMemoryService({ mcpUrl: MCP_URL, clients: store, fallback, fetchImpl: fake.fetchImpl });
  assert.equal(await brain.capture(scope, ["survives outage"], Date.UTC(2026, 4, 31)), 1);
  assert.match(await brain.recall(scope), /survives outage/);
  assert.deepEqual(await brain.query(scope, "survives"), []);
});

test("wiring: BRAIN=mcp pointed at an unreachable brain still serves turns via the notebook floor", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gb-wire-"));
  const config = testConfig({
    dataDir,
    brain: "mcp",
    brainMcpUrl: "https://brain.invalid.test",
  });
  const { app, runtime } = buildApp(config);
  try {
    const actor = { externalId: "U1" };
    const dm = (text: string, thread: string): TurnRequest => ({
      surface: "test",
      actor,
      conversation: { kind: "dm", threadRef: thread },
      text,
    });
    assert.equal((await app.turn(dm("remember my X handle is be17832773", "dm:U1:tA"))).status, "ok");
    let reply = "";
    for (let i = 0; i < 100; i++) {
      const b = await app.turn(dm("!sysprompt", "dm:U1:tB"));
      assert.equal(b.status, "ok");
      reply = b.reply ?? "";
      if (/be17832773/.test(reply)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(reply, /be17832773/);
  } finally {
    await runtime.stop();
  }
});

test("the /mcp request advertises Accept: application/json AND text/event-stream", async () => {
  let accept = "";
  const fetchImpl: BrainFetch = async (url, init) => {
    if (url.endsWith("/token"))
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ access_token: "t", expires_in: 3600 });
        },
      };
    accept = init.headers.accept ?? "";
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          result: { structuredContent: { source_id: "personal-u1", federated_read: ["personal-u1", "shared"] } },
        });
      },
    };
  };
  const mcp = createBrainMcp({ mcpUrl: MCP_URL, fetchImpl });
  const token = await mcp.mintToken("c", "s");
  await mcp.call(token, "whoami", {});
  assert.match(accept, /application\/json/, "Accept still offers JSON");
  assert.match(accept, /text\/event-stream/, "Accept now offers SSE so v0.42 won't return -32000 Not Acceptable");
});

test("mcpCall parses an SSE-framed (text/event-stream) response into the same result as the JSON path", async () => {
  const result = { content: [{ type: "text", text: "The deploy runbook lives at ops/deploy.md" }] };
  const fetchImpl: BrainFetch = async (url, init) => {
    if (url.endsWith("/token")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ access_token: "t", expires_in: 3600 });
        },
      };
    }
    const reqId = (JSON.parse(init.body) as { id: number }).id;
    const sse =
      `event: message\n` +
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n` +
      `event: message\n` +
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: reqId, result })}\n\n`;
    return {
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream; charset=utf-8" : null) },
      async text() {
        return sse;
      },
    };
  };
  const mcp = createBrainMcp({ mcpUrl: MCP_URL, fetchImpl });
  const token = await mcp.mintToken("c", "s");
  assert.deepEqual(
    await mcp.call(token, "search", { query: "deploy" }),
    result,
    "SSE result matches the JSON-path result object",
  );
});

test("mcpCall surfaces a JSON-RPC error delivered over SSE", async () => {
  const fetchImpl: BrainFetch = async (url, init) => {
    if (url.endsWith("/token"))
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ access_token: "t", expires_in: 3600 });
        },
      };
    const reqId = (JSON.parse(init.body) as { id: number }).id;
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: reqId, error: { code: -32000, message: "Not Acceptable" } })}\n\n`;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      async text() {
        return sse;
      },
    };
  };
  const mcp = createBrainMcp({ mcpUrl: MCP_URL, fetchImpl });
  const token = await mcp.mintToken("c", "s");
  await assert.rejects(() => mcp.call(token, "search", {}), /Not Acceptable/);
});

test("an SSE stream that never delivers a result/error is a hard failure, not empty success", async () => {
  const fetchImpl: BrainFetch = async (url, init) => {
    if (url.endsWith("/token"))
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ access_token: "t", expires_in: 3600 });
        },
      };
    const reqId = (JSON.parse(init.body) as { id: number }).id;
    const sse =
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "notifications/progress", params: { progress: 1 } })}\n\n` +
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "notifications/progress", params: { progress: 2 } })}\n\n`;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      async text() {
        return sse;
      },
    };
  };
  const mcp = createBrainMcp({ mcpUrl: MCP_URL, fetchImpl });
  const token = await mcp.mintToken("c", "s");
  await assert.rejects(() => mcp.call(token, "search", {}), /returned non-JSON/);
});

test("secrets never enter the audit log (host + scope + tool only)", async () => {
  const { brain, audit, scope, client } = setup(scopeId("personal", "U1"));
  await brain.capture(scope, ["a fact"], Date.UTC(2026, 4, 31));
  await brain.recall(scope);
  await brain.query(scope, "fact");
  const dump = JSON.stringify(await audit.events());
  assert.ok(!dump.includes(client.clientSecret), "client secret must never be audited");
  assert.ok(!dump.includes("tok-"), "access tokens must never be audited");
  for (const e of await audit.events()) {
    if (e.action.startsWith("brain.")) assert.equal(e.resource, "brain.acme.test");
  }
});
