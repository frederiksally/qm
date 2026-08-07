import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrainQueryService } from "../src/memory/brain-query-service.ts";

const MCP_URL = process.env.BRAIN_LIVE_MCP_URL;
const BEARER_TOKEN = process.env.BRAIN_LIVE_BEARER_TOKEN ?? "";
const KNOWN_SLUG = process.env.BRAIN_LIVE_SLUG ?? "atlas";
const ABSENT_SLUG = "no-such-entity-anywhere";
const skip = MCP_URL ? false : "set BRAIN_LIVE_MCP_URL (and BRAIN_LIVE_BEARER_TOKEN) to run the live wiki reads";

const wiki = (over: { mcpUrl?: string; bearerToken?: string } = {}) =>
  createBrainQueryService({
    mcpUrl: over.mcpUrl ?? MCP_URL ?? "",
    auth: "bearer",
    bearerToken: over.bearerToken ?? BEARER_TOKEN,
    queryTool: process.env.BRAIN_LIVE_QUERY_TOOL ?? "wiki_search",
    pageTool: process.env.BRAIN_LIVE_PAGE_TOOL ?? "wiki_page",
    recentTool: process.env.BRAIN_LIVE_RECENT_TOOL ?? "wiki_recent",
  });

test("live wiki: query returns ranked lines carrying the slug that brain_page takes", { skip }, async () => {
  const read = await wiki().query(KNOWN_SLUG);
  assert.equal(read.ok, true, "a search against a reachable wiki must be a successful read");
  const lines = read.ok ? read.lines : [];
  assert.ok(lines.length > 0, "the live wiki returned no hits for the known slug");
  assert.match(lines.join("\n"), new RegExp(KNOWN_SLUG), "a hit line names the slug the page read needs");
});

test("live wiki: a query matching nothing is empty, never a failure", { skip }, async () => {
  const read = await wiki().query("zzz-no-such-term-anywhere-in-this-wiki");
  assert.deepEqual(read, { ok: true, lines: [] }, "the wiki answered 'no matches' — that is an answer, not an outage");
});

test("live wiki: a wrong bearer token on query is a failure, never a confident no-match", { skip }, async () => {
  assert.deepEqual(await wiki({ bearerToken: "wrong-token-entirely" }).query(KNOWN_SLUG), { ok: false });
});

test("live wiki: page returns the full markdown for a known slug", { skip }, async () => {
  const read = await wiki().page(KNOWN_SLUG);
  assert.equal(read.ok, true, "a known slug must be a successful read");
  const body = read.ok ? (read.body ?? "") : "";
  assert.ok(body.length > 0, "a known slug must carry a body");
  assert.match(body, /^#{1,3} /m, "the body is the markdown page, not a one-line summary");
});

test("live wiki: recent returns the maintained feed", { skip }, async () => {
  const read = await wiki().recent();
  assert.equal(read.ok, true, "the recent feed must be a successful read");
  assert.ok(read.ok && (read.body ?? "").length > 0, "the seeded wiki has recent activity to report");
});

test("live wiki: a slug the wiki does not have is empty, never a failure", { skip }, async () => {
  const read = await wiki().page(ABSENT_SLUG);
  assert.deepEqual(
    read,
    { ok: true, body: null },
    "the wiki answered 'no such page' — that is an answer, not an outage",
  );
});

test("live wiki: a wrong bearer token is a failure, never a confident empty", { skip }, async () => {
  const svc = wiki({ bearerToken: "wrong-token-entirely" });
  assert.deepEqual(await svc.page(KNOWN_SLUG), { ok: false });
  assert.deepEqual(await svc.recent(), { ok: false });
});

test("live wiki: an unreachable wiki is a failure, never a confident empty", { skip }, async () => {
  const svc = wiki({ mcpUrl: "http://127.0.0.1:1/mcp" });
  assert.deepEqual(await svc.page(KNOWN_SLUG), { ok: false });
  assert.deepEqual(await svc.recent(), { ok: false });
  assert.deepEqual(await svc.query(KNOWN_SLUG), { ok: false });
});
