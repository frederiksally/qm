import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrainQueryService } from "../src/memory/brain-query-service.ts";
import type { BrainFetch } from "../src/memory/brain-mcp.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";

const MCP_URL = "https://brain.example.test";
const RO_CLIENT = { clientId: "ro-reader", clientSecret: "ro-s3cr3t" };

interface FakeCall {
  kind: "token" | "mcp";
  tool?: string;
  args?: Record<string, unknown>;
}

function fakeBrain(
  opts: { failNetwork?: boolean; failQuery?: boolean; queryErrorText?: string; seed?: string[] } = {},
) {
  const calls: FakeCall[] = [];
  let mints = 0;
  const resp = (obj: unknown) => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(obj);
    },
  });
  const facts = opts.seed ?? [
    "The deploy runbook lives at ops/deploy.md",
    "On-call rotates weekly",
    "Postgres is the source of truth",
  ];

  const fetchImpl: BrainFetch = async (url, init) => {
    if (opts.failNetwork) throw new Error("ECONNREFUSED");
    if (url.endsWith("/token")) {
      mints++;
      calls.push({ kind: "token" });
      return resp({ access_token: `ro-tok-${mints}`, expires_in: 3600 });
    }
    const body = JSON.parse(init.body) as { params: { name: string; arguments?: Record<string, unknown> } };
    const name = body.params.name;
    const args = body.params.arguments ?? {};
    calls.push({ kind: "mcp", tool: name, args });
    if (name === "whoami") {
      return resp({
        result: { structuredContent: { source_id: "team-brain", federated_read: ["team-brain", "shared"] } },
      });
    }
    if (name === "query" || name === "search") {
      if (opts.failQuery) {
        return resp({
          result: { isError: true, content: opts.queryErrorText ? [{ type: "text", text: opts.queryErrorText }] : [] },
        });
      }
      const q = String(args.query ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const hits = facts.filter((f) => q.every((t) => f.toLowerCase().includes(t)));
      return resp({ result: { content: [{ type: "text", text: hits.join("\n") }] } });
    }
    if (name === "wiki_page") {
      if (args.slug === "missing") return resp({ result: { content: [{ type: "text", text: "" }] } });
      return resp({ result: { content: [{ type: "text", text: `# ${String(args.slug)}\n\nBody line one.` }] } });
    }
    if (name === "wiki_recent") {
      if (args.days === 0) return resp({ result: { content: [{ type: "text", text: "" }] } });
      return resp({ result: { content: [{ type: "text", text: "- atlas moved\n- maria updated" }] } });
    }
    return resp({
      result: { isError: true, content: [{ type: "text", text: `{"error":"insufficient_scope","op":"${name}"}` }] },
    });
  };

  return {
    fetchImpl,
    calls,
    get mints() {
      return mints;
    },
  };
}

const WRITE_TOOLS = new Set(["extract_facts", "recall", "capture", "think"]);

test("query mints a read-only token and runs `query` by default, returning fact lines", async () => {
  const fake = fakeBrain();
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl });
  const hits = await brain.query("deploy runbook");
  assert.deepEqual(hits, ["The deploy runbook lives at ops/deploy.md"]);
  assert.equal(
    fake.calls.find((c) => c.kind === "mcp" && c.tool && c.tool !== "whoami")?.tool,
    "query",
    "default query tool is query",
  );
});

test("queryTool:'search' switches to keyword search", async () => {
  const fake = fakeBrain();
  const brain = createBrainQueryService({
    mcpUrl: MCP_URL,
    ...RO_CLIENT,
    queryTool: "search",
    fetchImpl: fake.fetchImpl,
  });
  await brain.query("postgres");
  assert.ok(
    fake.calls.some((c) => c.tool === "search"),
    "issued a search call",
  );
  assert.ok(!fake.calls.some((c) => c.tool === "query"), "did not call query");
});

test("the read-only default never issues the write-scoped `think` op", async () => {
  const fake = fakeBrain();
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl });
  await brain.query("anything");
  assert.ok(!fake.calls.some((c) => c.tool === "think"), "default must not call the write-scoped think op");
});

test("the read-only client NEVER issues a write tool (extract_facts/recall/capture)", async () => {
  const fake = fakeBrain();
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl });
  await brain.query("anything");
  await brain.query("rotation");
  for (const c of fake.calls) {
    if (c.tool) assert.ok(!WRITE_TOOLS.has(c.tool), `read-only client must not call write tool ${c.tool}`);
  }
});

test("an empty/whitespace query short-circuits without touching the network", async () => {
  const fake = fakeBrain();
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl });
  assert.deepEqual(await brain.query("   "), []);
  assert.equal(fake.mints, 0, "no token minted for an empty query");
  assert.equal(fake.calls.length, 0);
});

test("the limit caps returned lines and is forwarded to the brain", async () => {
  const fake = fakeBrain({ seed: ["alpha note", "alpha and beta", "alpha gamma", "alpha delta"] });
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl });
  const hits = await brain.query("alpha", 2);
  assert.equal(hits.length, 2, "result is capped at the limit");
  const call = fake.calls.find((c) => c.tool === "query");
  assert.equal(call?.args?.limit, 2, "limit forwarded to the brain call");
});

test("fail-soft on a network error → [] (never throws)", async () => {
  const fake = fakeBrain({ failNetwork: true });
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl });
  assert.deepEqual(await brain.query("deploy"), []);
});

test("fail-soft on a tool error → [] (never throws)", async () => {
  const fake = fakeBrain({ failQuery: true });
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl });
  assert.deepEqual(await brain.query("deploy"), []);
});

test("a tool error is recorded in the audit log (not silently swallowed as empty)", async () => {
  const fake = fakeBrain({ failQuery: true, queryErrorText: '{"error":"insufficient_scope"}' });
  const audit = createAuditLog();
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl, audit });
  assert.deepEqual(await brain.query("deploy", undefined, "U1"), [], "still fails soft → []");
  const events = await audit.events();
  const ev = events.find((e) => e.action === "brain.query");
  assert.ok(ev, "a brain.query audit event was recorded");
  assert.ok(ev?.status?.startsWith("error:"), `status records the error, got: ${ev?.status}`);
  assert.ok(ev?.status?.includes("insufficient_scope"), `the underlying error detail is surfaced, got: ${ev?.status}`);
});

test("whoami is probed once for the identity log; secrets/tokens never enter the audit log", async () => {
  const fake = fakeBrain();
  const audit = createAuditLog();
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl, audit });
  await brain.query("deploy", undefined, "U1");
  await brain.query("rotation", undefined, "U1");
  assert.equal(fake.calls.filter((c) => c.tool === "whoami").length, 1, "whoami probed exactly once");
  const events = await audit.events();
  assert.ok(events.some((e) => e.action === "brain.whoami" && e.status?.includes("source=team-brain")));
  assert.ok(events.some((e) => e.action === "brain.query" && e.status === "ok"));
  const dump = JSON.stringify(events);
  assert.ok(!dump.includes(RO_CLIENT.clientSecret), "client secret must never be audited");
  assert.ok(!dump.includes("ro-tok-"), "access tokens must never be audited");
});

test("page returns the markdown body for a slug", async () => {
  const brain = fakeBrain();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page",
    fetchImpl: brain.fetchImpl,
  });
  const body = await svc.page("atlas");
  assert.equal(body, "# atlas\n\nBody line one.");
  assert.deepEqual(
    brain.calls.filter((c) => c.kind === "mcp").map((c) => c.tool),
    ["wiki_page"],
  );
});

test("page returns null when the page tool is not configured", async () => {
  const brain = fakeBrain();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    fetchImpl: brain.fetchImpl,
  });
  assert.equal(await svc.page("atlas"), null);
  assert.equal(brain.calls.length, 0);
});

test("page returns null for an empty body", async () => {
  const brain = fakeBrain();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page",
    fetchImpl: brain.fetchImpl,
  });
  assert.equal(await svc.page("missing"), null);
});

test("page returns null and does not throw when the brain is unreachable", async () => {
  const brain = fakeBrain({ failNetwork: true });
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page",
    fetchImpl: brain.fetchImpl,
  });
  assert.equal(await svc.page("atlas"), null);
});

test("recent passes the days window through and returns the feed", async () => {
  const brain = fakeBrain();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    recentTool: "wiki_recent",
    fetchImpl: brain.fetchImpl,
  });
  assert.equal(await svc.recent(7), "- atlas moved\n- maria updated");
  const call = brain.calls.find((c) => c.kind === "mcp");
  assert.deepEqual(call?.args, { days: 7 });
});

test("recent sends days only when a window is given, and never a fabricated default", async () => {
  const brain = fakeBrain();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    recentTool: "wiki_recent",
    fetchImpl: brain.fetchImpl,
  });
  await svc.recent();
  await svc.recent(7);
  await svc.recent(0);
  assert.deepEqual(
    brain.calls.filter((c) => c.kind === "mcp").map((c) => c.args),
    [{}, { days: 7 }, { days: 0 }],
  );
});

test("bearer auth never calls whoami for page or recent", async () => {
  const brain = fakeBrain();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page",
    recentTool: "wiki_recent",
    fetchImpl: brain.fetchImpl,
  });
  await svc.page("atlas");
  await svc.recent();
  assert.equal(
    brain.calls.some((c) => c.tool === "whoami"),
    false,
  );
});

test("page and recent audit ok against the calling principal on success", async () => {
  const brain = fakeBrain();
  const audit = createAuditLog();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page",
    recentTool: "wiki_recent",
    fetchImpl: brain.fetchImpl,
    audit,
  });
  await svc.page("atlas", "U1");
  await svc.recent(7, "U1");
  const events = await audit.events();
  assert.deepEqual(
    events.map((e) => [e.action, e.status, e.principalId]),
    [
      ["brain.wiki_page", "ok", "U1"],
      ["brain.wiki_recent", "ok", "U1"],
    ],
  );
});

test("an empty page and an empty recent feed are audited as empty, not ok", async () => {
  const brain = fakeBrain();
  const audit = createAuditLog();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page",
    recentTool: "wiki_recent",
    fetchImpl: brain.fetchImpl,
    audit,
  });
  assert.equal(await svc.page("missing", "U1"), null);
  assert.equal(await svc.recent(0, "U1"), null);
  const events = await audit.events();
  assert.deepEqual(
    events.map((e) => [e.action, e.status]),
    [
      ["brain.wiki_page", "empty"],
      ["brain.wiki_recent", "empty"],
    ],
  );
});

test("a tool error on page or recent is audited as error (not swallowed as empty) and fails soft to null", async () => {
  const brain = fakeBrain();
  const audit = createAuditLog();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page_private",
    recentTool: "wiki_recent_private",
    fetchImpl: brain.fetchImpl,
    audit,
  });
  assert.equal(await svc.page("atlas", "U1"), null, "page still fails soft → null");
  assert.equal(await svc.recent(7, "U1"), null, "recent still fails soft → null");
  const events = await audit.events();
  for (const action of ["brain.wiki_page_private", "brain.wiki_recent_private"]) {
    const ev = events.find((e) => e.action === action);
    assert.ok(ev, `a ${action} audit event was recorded`);
    assert.ok(ev?.status?.startsWith("error:"), `status records the error, got: ${ev?.status}`);
    assert.ok(ev?.status?.includes("insufficient_scope"), `the underlying detail is surfaced, got: ${ev?.status}`);
  }
});

test("a token failure on page or recent is audited as token_error and never reaches the brain", async () => {
  const brain = fakeBrain();
  const audit = createAuditLog();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    pageTool: "wiki_page",
    recentTool: "wiki_recent",
    fetchImpl: brain.fetchImpl,
    audit,
  });
  assert.equal(await svc.page("atlas", "U1"), null);
  assert.equal(await svc.recent(7, "U1"), null);
  assert.equal(brain.calls.length, 0, "an unresolvable token must not issue a brain call");
  const events = await audit.events();
  assert.deepEqual(
    events.map((e) => e.action),
    ["brain.wiki_page", "brain.wiki_recent"],
  );
  for (const ev of events) {
    assert.ok(ev.status?.startsWith("token_error:"), `status records the token failure, got: ${ev.status}`);
  }
});
