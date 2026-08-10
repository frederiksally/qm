import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";

const core = createServer((req: IncomingMessage, res) => {
  if ((req.url ?? "").startsWith("/v1/surface-config")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(
      JSON.stringify({ branding: { accent: "#f0652f", mark: "Y", markImage: "/brand.png", selfLabel: "QM" } }),
    );
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "web-ui-branding-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist-web");
const distIndex = join(distDir, "index.html");
if (!existsSync(distIndex)) {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    distIndex,
    '<!doctype html><html><head><meta name="brand-self-label" content="Agent" /></head><body></body></html>',
  );
}

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("cold start: the FIRST shell render already carries accent, mark, and self-label", async () => {
  const r = await fetch(`${base}/`, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /--brand-accent:#f0652f/, "accent injected on the first render");
  assert.match(html, /--brand-mark:"Y"/, "mark injected on the first render");
  assert.match(
    html,
    /<meta name="brand-self-label" content="QM"\s*\/?>/,
    "self-label meta injected regardless of template formatting",
  );
});

test("the vite template carries the self-label anchor the server injects into", () => {
  const template = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(template, /<meta name="brand-self-label" content="QM"\s*\/?>/);
});

test("the vite template carries the mark-image anchor the server injects into", () => {
  const template = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(template, /<meta name="brand-mark-image" content=""\s*\/?>/);
});

test("brandName() reads the injected self-label and falls back to the product name", async () => {
  const ui = await import("../src/ui.ts");
  const brandName = (ui as { brandName?: () => string }).brandName;
  assert.equal(typeof brandName, "function", "ui.ts exports brandName()");
  const dom = new JSDOM('<head><meta name="brand-self-label" content="Acme"></head>');
  (globalThis as { document?: Document }).document = dom.window.document;
  try {
    assert.equal(brandName!(), "Acme");
  } finally {
    delete (globalThis as { document?: Document }).document;
  }
  assert.equal(brandName!(), "QM");
});

test("markImage is injected as meta and favicon on the first render", async () => {
  const r = await fetch(`${base}/`, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<meta name="brand-mark-image" content="\/brand\.png"\s*\/?>/, "mark-image meta injected");
  assert.match(html, /<link rel="icon" href="\/brand\.png"\s*\/?>/, "favicon follows the mark image");
});

test("injectBranding inserts the mark-image meta when the template lacks it", async () => {
  const { injectBranding } = await import("../../chassis/src/branding.ts");
  const out = injectBranding("<html><head><title>t</title></head><body></body></html>", {
    markImage: "https://cdn.example.com/logo.svg",
  });
  assert.ok(out.includes('<meta name="brand-mark-image" content="https://cdn.example.com/logo.svg">'), "meta inserted");
  assert.ok(
    out.includes('<link rel="icon" href="https://cdn.example.com/logo.svg">'),
    "favicon link inserted when absent",
  );
});

test("brandMarkImage() reads the injected meta and falls back to empty", async () => {
  const ui = await import("../src/ui.ts");
  const brandMarkImage = (ui as { brandMarkImage?: () => string }).brandMarkImage;
  assert.equal(typeof brandMarkImage, "function", "ui.ts exports brandMarkImage()");
  const dom = new JSDOM('<head><meta name="brand-mark-image" content="/brand.png"></head>');
  (globalThis as { document?: Document }).document = dom.window.document;
  try {
    assert.equal(brandMarkImage!(), "/brand.png");
  } finally {
    delete (globalThis as { document?: Document }).document;
  }
  assert.equal(brandMarkImage!(), "");
});

test("BRAND_MARK_IMAGE_FILE is served at /brand.png with the png content type", async () => {
  const dir = join(distDir, ".brand-test");
  mkdirSync(dir, { recursive: true });
  const pngPath = join(dir, "brand.png");
  writeFileSync(pngPath, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  process.env.BRAND_MARK_IMAGE_FILE = pngPath;
  try {
    const r = await fetch(`${base}/brand.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.subarray(0, 4).toString("hex"), "89504e47", "png signature round-trips");

    const fav = await fetch(`${base}/favicon.svg`);
    assert.equal(fav.headers.get("content-type"), "image/png", "favicon prefers the brand image");
  } finally {
    delete process.env.BRAND_MARK_IMAGE_FILE;
  }
});
