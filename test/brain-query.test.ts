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
  opts: {
    failNetwork?: boolean;
    failQuery?: boolean;
    queryErrorText?: string;
    seed?: string[];
    httpStatus?: Record<string, number>;
    plainErrorBody?: boolean;
  } = {},
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
  const httpError = (status: number, id: unknown, message: string) => ({
    ok: false,
    status,
    async text() {
      return opts.plainErrorBody
        ? "<html><body>not found</body></html>"
        : JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } });
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
    const body = JSON.parse(init.body) as {
      id?: unknown;
      params: { name: string; arguments?: Record<string, unknown> };
    };
    const name = body.params.name;
    const args = body.params.arguments ?? {};
    calls.push({ kind: "mcp", tool: name, args });
    const status = opts.httpStatus?.[name];
    if (status) return httpError(status, body.id, `unknown page: ${String(args.slug ?? "")}`);
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
  assert.deepEqual(await brain.query("deploy runbook"), {
    ok: true,
    lines: ["The deploy runbook lives at ops/deploy.md"],
  });
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
  assert.deepEqual(
    await brain.query("   "),
    { ok: false },
    "a blank query is a failed lookup, not a claim of no match",
  );
  assert.equal(fake.mints, 0, "no token minted for an empty query");
  assert.equal(fake.calls.length, 0);
});

test("the limit caps returned lines and is forwarded to the brain", async () => {
  const fake = fakeBrain({ seed: ["alpha note", "alpha and beta", "alpha gamma", "alpha delta"] });
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl });
  const read = await brain.query("alpha", 2);
  assert.equal(read.ok && read.lines.length, 2, "result is capped at the limit");
  const call = fake.calls.find((c) => c.tool === "query");
  assert.equal(call?.args?.limit, 2, "limit forwarded to the brain call");
});

test("fail-soft on a network error → a reported failure (never throws, never a false empty)", async () => {
  const fake = fakeBrain({ failNetwork: true });
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl });
  assert.deepEqual(await brain.query("deploy"), { ok: false });
});

test("fail-soft on a tool error → a reported failure (never throws, never a false empty)", async () => {
  const fake = fakeBrain({ failQuery: true });
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl });
  assert.deepEqual(await brain.query("deploy"), { ok: false });
});

test("a tool error is recorded in the audit log (not silently swallowed as empty)", async () => {
  const fake = fakeBrain({ failQuery: true, queryErrorText: '{"error":"insufficient_scope"}' });
  const audit = createAuditLog();
  const brain = createBrainQueryService({ mcpUrl: MCP_URL, ...RO_CLIENT, fetchImpl: fake.fetchImpl, audit });
  assert.deepEqual(await brain.query("deploy", undefined, "U1"), { ok: false }, "still fails soft");
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
  assert.deepEqual(await svc.page("atlas"), { ok: true, body: "# atlas\n\nBody line one." });
  assert.deepEqual(
    brain.calls.filter((c) => c.kind === "mcp").map((c) => c.tool),
    ["wiki_page"],
  );
});

test("page reports a failed lookup when the page tool is not configured", async () => {
  const brain = fakeBrain();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    fetchImpl: brain.fetchImpl,
  });
  assert.deepEqual(await svc.page("atlas"), { ok: false });
  assert.equal(brain.calls.length, 0);
});

test("page reports a reached-but-empty page distinctly from a failure", async () => {
  const brain = fakeBrain();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page",
    fetchImpl: brain.fetchImpl,
  });
  assert.deepEqual(await svc.page("missing"), { ok: true, body: null });
});

test("page reports a failed lookup and does not throw when the brain is unreachable", async () => {
  const brain = fakeBrain({ failNetwork: true });
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page",
    fetchImpl: brain.fetchImpl,
  });
  assert.deepEqual(await svc.page("atlas"), { ok: false });
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
  assert.deepEqual(await svc.recent(7), { ok: true, body: "- atlas moved\n- maria updated" });
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
  assert.deepEqual(await svc.page("missing", "U1"), { ok: true, body: null });
  assert.deepEqual(await svc.recent(0, "U1"), { ok: true, body: null });
  const events = await audit.events();
  assert.deepEqual(
    events.map((e) => [e.action, e.status]),
    [
      ["brain.wiki_page", "empty"],
      ["brain.wiki_recent", "empty"],
    ],
  );
});

test("a tool error on page or recent is audited as error (not swallowed as empty) and fails soft", async () => {
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
  assert.deepEqual(await svc.page("atlas", "U1"), { ok: false }, "page still fails soft, and says so");
  assert.deepEqual(await svc.recent(7, "U1"), { ok: false }, "recent still fails soft, and says so");
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
  assert.deepEqual(await svc.page("atlas", "U1"), { ok: false });
  assert.deepEqual(await svc.recent(7, "U1"), { ok: false });
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

test("an empty page and an empty recent feed are never conflated with a failed lookup", async () => {
  const reachable = fakeBrain();
  const reached = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page",
    recentTool: "wiki_recent",
    fetchImpl: reachable.fetchImpl,
  });
  assert.deepEqual(await reached.page("missing"), { ok: true, body: null }, "reached, genuinely no page");
  assert.deepEqual(await reached.recent(0), { ok: true, body: null }, "reached, genuinely idle window");

  const down = fakeBrain({ failNetwork: true });
  const unreachable = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page",
    recentTool: "wiki_recent",
    fetchImpl: down.fetchImpl,
  });
  assert.deepEqual(await unreachable.page("missing"), { ok: false }, "an outage is not an absent page");
  assert.deepEqual(await unreachable.recent(0), { ok: false }, "an outage is not an idle company");
});

test("a blank slug is a failed lookup, not a claim that the wiki has no such page", async () => {
  const brain = fakeBrain();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page",
    fetchImpl: brain.fetchImpl,
  });
  assert.deepEqual(await svc.page("   "), { ok: false });
  assert.equal(brain.calls.length, 0);
});

test("recent reports a failed lookup when the recent tool is not configured", async () => {
  const brain = fakeBrain();
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    fetchImpl: brain.fetchImpl,
  });
  assert.deepEqual(await svc.recent(7), { ok: false });
  assert.equal(brain.calls.length, 0);
});

const wikiPageSvc = (brain: ReturnType<typeof fakeBrain>, audit?: ReturnType<typeof createAuditLog>) =>
  createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    bearerToken: "tok",
    pageTool: "wiki_page",
    recentTool: "wiki_recent",
    fetchImpl: brain.fetchImpl,
    ...(audit ? { audit } : {}),
  });

test("an HTTP 404 on page is the wiki saying the page does not exist: empty, audited empty, never a failure", async () => {
  const brain = fakeBrain({ httpStatus: { wiki_page: 404 } });
  const audit = createAuditLog();
  assert.deepEqual(await wikiPageSvc(brain, audit).page("no-such-entity", "U1"), { ok: true, body: null });
  const events = await audit.events();
  assert.deepEqual(
    events.map((e) => [e.action, e.status]),
    [["brain.wiki_page", "empty"]],
    "a page the wiki does not have is an empty read, not an error",
  );
});

test("an HTTP 409 (page unavailable) stays a failure — possibly transient is never reported as absent", async () => {
  const brain = fakeBrain({ httpStatus: { wiki_page: 409 } });
  const audit = createAuditLog();
  assert.deepEqual(await wikiPageSvc(brain, audit).page("atlas", "U1"), { ok: false });
  const events = await audit.events();
  assert.equal(events.length, 1);
  assert.ok(events[0]?.status?.startsWith("error:"), `409 is audited as an error, got: ${events[0]?.status}`);
});

test("an HTTP 500 on page stays a failure", async () => {
  const brain = fakeBrain({ httpStatus: { wiki_page: 500 } });
  assert.deepEqual(await wikiPageSvc(brain).page("atlas"), { ok: false });
});

test("an HTTP 404 without a JSON-RPC error body is a transport failure, not an absent page", async () => {
  const brain = fakeBrain({ httpStatus: { wiki_page: 404 }, plainErrorBody: true });
  const audit = createAuditLog();
  assert.deepEqual(
    await wikiPageSvc(brain, audit).page("atlas", "U1"),
    { ok: false },
    "a routing 404 must not make every page look absent",
  );
  const events = await audit.events();
  assert.ok(events[0]?.status?.startsWith("error:"), `got: ${events[0]?.status}`);
});

test("an HTTP 404 on recent stays a failure — an absent feed is not an idle company", async () => {
  const brain = fakeBrain({ httpStatus: { wiki_recent: 404 } });
  assert.deepEqual(await wikiPageSvc(brain).recent(7), { ok: false });
});

const searchSvc = (brain: ReturnType<typeof fakeBrain>, audit?: ReturnType<typeof createAuditLog>) =>
  createBrainQueryService({
    mcpUrl: MCP_URL,
    ...RO_CLIENT,
    fetchImpl: brain.fetchImpl,
    ...(audit ? { audit } : {}),
  });

test("a search that matches nothing is a reached-and-empty result, audited empty like an empty page", async () => {
  const fake = fakeBrain();
  const audit = createAuditLog();
  const read = await searchSvc(fake, audit).query("nothing-whatsoever-matches-this", undefined, "U1");
  assert.deepEqual(read, { ok: true, lines: [] }, "the wiki answered — nothing matched");
  const events = await audit.events();
  assert.equal(
    events.find((e) => e.action === "brain.query")?.status,
    "empty",
    "a zero-match search audits empty, the same word an empty page uses",
  );
});

test("a search that matches nothing is distinguishable from every way the lookup can fail", async () => {
  const reached = await searchSvc(fakeBrain()).query("nothing-whatsoever-matches-this");
  assert.deepEqual(reached, { ok: true, lines: [] });

  const unreachable = await searchSvc(fakeBrain({ failNetwork: true })).query("deploy");
  assert.deepEqual(unreachable, { ok: false }, "an outage is not an absence of matches");

  const toolError = await searchSvc(fakeBrain({ failQuery: true })).query("deploy");
  assert.deepEqual(toolError, { ok: false }, "a tool error is not an absence of matches");

  const http404 = await searchSvc(fakeBrain({ httpStatus: { query: 404 } })).query("deploy");
  assert.deepEqual(http404, { ok: false }, "a 404 on the search tool is not an absence of matches");

  const badToken = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    fetchImpl: fakeBrain().fetchImpl,
  });
  assert.deepEqual(await badToken.query("deploy"), { ok: false }, "a token failure is not an absence of matches");
});

test("a token failure on query is audited as token_error and never reaches the brain", async () => {
  const fake = fakeBrain();
  const audit = createAuditLog();
  const svc = createBrainQueryService({ mcpUrl: MCP_URL, auth: "bearer", fetchImpl: fake.fetchImpl, audit });
  assert.deepEqual(await svc.query("deploy", undefined, "U1"), { ok: false });
  assert.equal(fake.calls.length, 0, "an unresolvable token must not issue a brain call");
  const events = await audit.events();
  assert.ok(
    events.find((e) => e.action === "brain.query")?.status?.startsWith("token_error:"),
    `status records the token failure, got: ${events.find((e) => e.action === "brain.query")?.status}`,
  );
});

test("a query read with no brain configured at all is a failure, never an empty result", async () => {
  const svc = createBrainQueryService({
    mcpUrl: MCP_URL,
    auth: "bearer",
    fetchImpl: fakeBrain({ failNetwork: true }).fetchImpl,
  });
  assert.deepEqual(await svc.query("deploy"), { ok: false });
});
