import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import type { BrainQueryService } from "../src/memory/brain-query-service.ts";
import { testConfig } from "./support/test-config.ts";

const calls: Array<{ operation: string; value: string | number | undefined; principal?: string }> = [];
const brain: BrainQueryService = {
  async query(q, limit, principal) {
    calls.push({ operation: "query", value: `${q}:${limit}`, principal });
    return { ok: true, lines: ["atlas | project | Customer launch"] };
  },
  async page(slug, principal) {
    calls.push({ operation: "page", value: slug, principal });
    return { ok: true, body: slug === "missing" ? null : `# ${slug}\n\nCurrent context.` };
  },
  async recent(days, principal) {
    calls.push({ operation: "recent", value: days, principal });
    return { ok: true, body: "- atlas moved to active" };
  },
};

async function start(withBrain = true) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-wiki-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    ...(withBrain ? { brain } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const headers = { "x-admin-actor": "admin-alice@default-org" };

test("admin wiki reads use the shared brain service and audit the administrator", async () => {
  calls.length = 0;
  const s = await start();
  try {
    const search = await fetch(`${s.base}/v1/admin/wiki/search?q=atlas&limit=50`, { headers });
    assert.equal(search.status, 200);
    assert.deepEqual(await search.json(), { query: "atlas", lines: ["atlas | project | Customer launch"] });

    const page = await fetch(`${s.base}/v1/admin/wiki/pages/atlas`, { headers });
    assert.equal(page.status, 200);
    assert.deepEqual(await page.json(), { slug: "atlas", body: "# atlas\n\nCurrent context." });

    const recent = await fetch(`${s.base}/v1/admin/wiki/recent?days=90`, { headers });
    assert.equal(recent.status, 200);
    assert.deepEqual(await recent.json(), { days: 90, body: "- atlas moved to active" });
    assert.deepEqual(calls, [
      { operation: "query", value: "atlas:50", principal: "admin-alice" },
      { operation: "page", value: "atlas", principal: "admin-alice" },
      { operation: "recent", value: 90, principal: "admin-alice" },
    ]);
    const events = await s.built.auditLog.events();
    assert.deepEqual(
      events.filter((event) => event.action.startsWith("wiki.")).map((event) => event.action),
      ["wiki.search", "wiki.page", "wiki.recent"],
    );
  } finally {
    await s.close();
  }
});

test("admin wiki distinguishes missing pages from an unconfigured wiki", async () => {
  const available = await start();
  try {
    const missing = await fetch(`${available.base}/v1/admin/wiki/pages/missing`, { headers });
    assert.equal(missing.status, 404);
  } finally {
    await available.close();
  }
  const unavailable = await start(false);
  try {
    const response = await fetch(`${unavailable.base}/v1/admin/wiki/recent`, { headers });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "wiki_unavailable" });
  } finally {
    await unavailable.close();
  }
});

test("admin wiki rejects blank searches before spending a brain request", async () => {
  const s = await start();
  try {
    const before = calls.length;
    const response = await fetch(`${s.base}/v1/admin/wiki/search?q=%20`, { headers });
    assert.equal(response.status, 400);
    assert.equal(calls.length, before);
  } finally {
    await s.close();
  }
});

test("admin wiki rejects values that cannot satisfy the MCP schemas", async () => {
  const s = await start();
  try {
    const before = calls.length;
    for (const path of [
      "/v1/admin/wiki/search?q=atlas&limit=1.5",
      "/v1/admin/wiki/search?q=atlas&limit=51",
      "/v1/admin/wiki/recent?days=2.5",
      "/v1/admin/wiki/recent?days=0",
      "/v1/admin/wiki/pages/%20",
      "/v1/admin/wiki/pages/" + "a".repeat(201),
      "/v1/admin/wiki/pages/" + encodeURIComponent("𠀀".repeat(101)),
    ]) {
      const response = await fetch(s.base + path, { headers });
      assert.equal(response.status, 400, path);
    }
    assert.equal(calls.length, before);
  } finally {
    await s.close();
  }
});

test("admin wiki accepts Unicode slugs from the wiki contract", async () => {
  const s = await start();
  try {
    for (const slug of ["københavn", "東京", "a".repeat(200), "𠀀".repeat(100)]) {
      const response = await fetch(`${s.base}/v1/admin/wiki/pages/${encodeURIComponent(slug)}`, { headers });
      assert.equal(response.status, 200, slug);
    }
  } finally {
    await s.close();
  }
});
