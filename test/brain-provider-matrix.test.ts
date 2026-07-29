import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrainQueryService, type BrainQueryOptions } from "../src/memory/brain-query-service.ts";
import { createBrainMemoryService, sourceForScope } from "../src/memory/brain-memory-service.ts";
import { createBrainClientStore, type BrainClient } from "../src/memory/brain-client-store.ts";
import type { BrainFetch } from "../src/memory/brain-mcp.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { scopeId } from "../src/types.ts";

const MCP_URL = "https://brain.provider.test";
const BEARER_TOKEN = "static-bearer-tok";

interface ServerShape {
  framing: "sse" | "json";
  auth: "oauth" | "bearer";
  tool: string;
}

interface ServerCall {
  kind: "token" | "mcp";
  tool?: string;
  authorization?: string;
  args?: Record<string, unknown>;
}

function fakeServer(shape: ServerShape, opts: { seed?: string[]; failQuery?: boolean } = {}) {
  const calls: ServerCall[] = [];
  const facts = opts.seed ?? ["The deploy runbook lives at ops/deploy.md", "On-call rotates weekly"];
  let mints = 0;

  const frame = (envelope: unknown, reqId: unknown) => {
    if (shape.framing === "json") {
      return {
        ok: true,
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
        async text() {
          return JSON.stringify({ jsonrpc: "2.0", id: reqId, ...(envelope as object) });
        },
      };
    }
    const sse =
      `event: message\n` +
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n` +
      `event: message\n` +
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: reqId, ...(envelope as object) })}\n\n`;
    return {
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
      async text() {
        return sse;
      },
    };
  };

  const fetchImpl: BrainFetch = async (url, init) => {
    if (url.endsWith("/token")) {
      calls.push({ kind: "token" });
      if (shape.auth === "bearer")
        return {
          ok: false,
          status: 404,
          async text() {
            return "no token endpoint";
          },
        };
      mints++;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ access_token: `minted-${mints}`, expires_in: 3600 });
        },
      };
    }
    const authorization = init.headers.authorization ?? "";
    const body = JSON.parse(init.body) as {
      id: unknown;
      params: { name: string; arguments?: Record<string, unknown> };
    };
    const name = body.params.name;
    const args = body.params.arguments ?? {};
    calls.push({ kind: "mcp", tool: name, authorization, args });
    const expected = shape.auth === "bearer" ? `Bearer ${BEARER_TOKEN}` : `Bearer minted-${mints}`;
    if (authorization !== expected) return frame({ error: { message: "unauthorized" } }, body.id);
    if (name === "whoami") {
      return frame(
        { result: { structuredContent: { source_id: "personal-u1", federated_read: ["personal-u1", "shared"] } } },
        body.id,
      );
    }
    if (name !== shape.tool) return frame({ error: { message: `unknown tool ${name}` } }, body.id);
    if (opts.failQuery) return frame({ error: { message: "backend unavailable" } }, body.id);
    const q = String(args.query ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const hits = facts.filter((f) => q.every((t) => f.toLowerCase().includes(t)));
    return frame({ result: { content: [{ type: "text", text: hits.join("\n") }] } }, body.id);
  };

  return {
    fetchImpl,
    calls,
    get mints() {
      return mints;
    },
  };
}

interface Provider {
  name: string;
  shape: ServerShape;
  queryOpts(fetchImpl: BrainFetch): BrainQueryOptions;
}

const PROVIDERS: Provider[] = [
  {
    name: "graph-brain-shaped (oauth client credentials, SSE framing, `query` tool)",
    shape: { framing: "sse", auth: "oauth", tool: "query" },
    queryOpts: (fetchImpl) => ({
      mcpUrl: MCP_URL,
      clientId: "ro-reader",
      clientSecret: "ro-s3cr3t",
      queryTool: "query",
      fetchImpl,
    }),
  },
  {
    name: "glean-shaped (static bearer token, plain JSON framing, `search` tool)",
    shape: { framing: "json", auth: "bearer", tool: "search" },
    queryOpts: (fetchImpl) => ({
      mcpUrl: MCP_URL,
      auth: "bearer",
      bearerToken: BEARER_TOKEN,
      queryTool: "search",
      fetchImpl,
    }),
  },
];

for (const provider of PROVIDERS) {
  test(`${provider.name}: query returns fact lines through the shared query-service path`, async () => {
    const fake = fakeServer(provider.shape);
    const brain = createBrainQueryService(provider.queryOpts(fake.fetchImpl));
    assert.deepEqual(await brain.query("deploy runbook"), ["The deploy runbook lives at ops/deploy.md"]);
    const call = fake.calls.find((c) => c.kind === "mcp" && c.tool === provider.shape.tool);
    assert.ok(call, `the ${provider.shape.tool} tool was called`);
  });

  test(`${provider.name}: a server-side error fails open to [] and lands in the audit log`, async () => {
    const fake = fakeServer(provider.shape, { failQuery: true });
    const audit = createAuditLog();
    const brain = createBrainQueryService({ ...provider.queryOpts(fake.fetchImpl), audit });
    assert.deepEqual(await brain.query("deploy", undefined, "U1"), []);
    const events = await audit.events();
    const ev = events.find((e) => e.action === `brain.${provider.shape.tool}`);
    assert.ok(ev, "an audit row was recorded for the failed query");
    assert.ok(ev?.status?.startsWith("error:"), `status carries the error, got: ${ev?.status}`);
    assert.equal(ev?.scopeLabel, "team-brain");
  });

  test(`${provider.name}: an empty query never touches the network`, async () => {
    const fake = fakeServer(provider.shape);
    const brain = createBrainQueryService(provider.queryOpts(fake.fetchImpl));
    assert.deepEqual(await brain.query("   "), []);
    assert.equal(fake.calls.length, 0);
  });
}

test("bearer auth sends the static token and NEVER hits a token-mint endpoint", async () => {
  const fake = fakeServer({ framing: "json", auth: "bearer", tool: "search" });
  const brain = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: BEARER_TOKEN,
    queryTool: "search",
    fetchImpl: fake.fetchImpl,
  });
  await brain.query("deploy");
  await brain.query("rotates");
  assert.equal(fake.calls.filter((c) => c.kind === "token").length, 0, "no token-mint request was made");
  for (const c of fake.calls) {
    assert.equal(c.authorization, `Bearer ${BEARER_TOKEN}`, "every request carries the static bearer token");
  }
});

test("oauth auth mints once, caches, and sends the minted token", async () => {
  const fake = fakeServer({ framing: "sse", auth: "oauth", tool: "query" });
  const brain = createBrainQueryService({
    mcpUrl: MCP_URL,
    clientId: "ro-reader",
    clientSecret: "ro-s3cr3t",
    fetchImpl: fake.fetchImpl,
  });
  await brain.query("deploy");
  await brain.query("rotates");
  assert.equal(fake.mints, 1, "token minted once and cached across queries");
  const mcpCalls = fake.calls.filter((c) => c.kind === "mcp");
  assert.ok(mcpCalls.every((c) => c.authorization === "Bearer minted-1"));
});

for (const framing of ["sse", "json"] as const) {
  test(`memory service parses ${framing}-framed provider responses through the same code path`, async () => {
    const scope = scopeId("personal", "U1");
    const src = sourceForScope(scope);
    assert.equal(src, "personal-u1");
    const fake = fakeServer({ framing, auth: "oauth", tool: "search" }, { seed: ["Org wifi is guestnet"] });
    const store = createBrainClientStore(createMemoryMap<BrainClient>());
    await store.set(scope, {
      clientId: "ro-reader",
      clientSecret: "ro-s3cr3t",
      source: src,
      federatedRead: [src, "shared"],
    });
    const audit = createAuditLog();
    const fallback = createMemoryService(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "brain-"))));
    const brain = createBrainMemoryService({
      mcpUrl: MCP_URL,
      clients: store,
      fallback,
      audit,
      fetchImpl: fake.fetchImpl,
    });
    assert.deepEqual(await brain.query(scope, "wifi"), ["Org wifi is guestnet"]);
    assert.deepEqual(await brain.query(scope, "no-match-here"), []);
    const events = await audit.events();
    assert.ok(events.some((e) => e.action === "brain.search" && e.status === "ok"));
  });
}
