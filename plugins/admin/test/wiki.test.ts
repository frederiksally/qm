import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("wiki is a first-class admin view backed by read-only endpoints", () => {
  assert.match(html, /views: \["history", "slack", "wiki", "judgments"\]/);
  assert.match(html, /wiki: "Wiki"/);
  assert.match(html, /async function renderWiki\(st\)/);
  assert.match(html, /\/api\/wiki\/search\?q=/);
  assert.match(html, /\/api\/wiki\/pages\//);
  assert.match(html, /\/api\/wiki\/recent\?days=7/);
  assert.match(server, /"wiki"/);
  assert.doesNotMatch(server, /\["wiki", \[(?:"POST"|"PUT"|"PATCH"|"DELETE")/);
});

test("wiki page and search state survives navigation and direct links", () => {
  assert.match(html, /p\.set\("slug", st\.slug\)/);
  assert.match(html, /p\.set\("q", st\.q\)/);
  assert.match(html, /slug: p\.get\("slug"\) \|\| null/);
  assert.match(html, /q: p\.get\("q"\) \|\| null/);
});

test("a stale focused wiki refreshes through its own reader", () => {
  const focus = html.match(/window\.addEventListener\("focus", \(\) => \{[\s\S]*?\n {6}\}\);/)?.[0];
  assert.ok(focus);
  assert.match(focus, /if \(view === "wiki"\) \{\s*renderWiki\(urlToState\(\)\);\s*return;/);
  assert.match(html, /await renderSearch\(\);\s*viewLoadedAt\.wiki = Date\.now\(\);/);
});

test("wiki search recognizes the full wiki slug contract", () => {
  const source = html.match(/function wikiSlugFromLine\(line\) \{[\s\S]*?\n {6}\}/)?.[0];
  assert.ok(source);
  const slugFrom = new Function(`${source}; return wikiSlugFromLine;`)();
  assert.equal(slugFrom("københavn | project | Danish office"), "københavn");
  assert.equal(slugFrom("東京 | project | Japan launch"), "東京");
  assert.equal(slugFrom("slug: `" + "a".repeat(200) + "`"), "a".repeat(200));
  assert.equal(slugFrom("slug: `" + "a".repeat(201) + "`"), null);
  assert.equal(slugFrom("slug: `" + "𠀀".repeat(100) + "`"), "𠀀".repeat(100));
  assert.equal(slugFrom("slug: `" + "𠀀".repeat(101) + "`"), null);
});

test("wiki text is rendered through the existing safe markdown renderer", () => {
  assert.match(html, /function renderWikiMarkdown\(text\)/);
  assert.match(html, /function wikiMarkdownParts\(text\)/);
  assert.match(html, /readerTitle\.textContent = rendered\.title/);
  assert.match(html, /code\.textContent = fence\.lines\.join/);
  assert.doesNotMatch(html, /wiki[\s\S]{0,80}innerHTML/);
});

test("wiki headings remain separate from the body line that follows", () => {
  const source = html.match(/function wikiMarkdownParts\(text\) \{[\s\S]*?\n {6}\}/)?.[0];
  assert.ok(source);
  const parse = new Function(`${source}; return wikiMarkdownParts;`)();
  assert.deepEqual(parse("# Atlas\n\n## Status\nActive today\n\n### Team\n- Maria"), {
    title: "Atlas",
    parts: [
      { kind: "heading", level: 2, text: "Status" },
      { kind: "body", text: "Active today\n" },
      { kind: "heading", level: 3, text: "Team" },
      { kind: "body", text: "- Maria" },
    ],
  });
  assert.deepEqual(parse("```md\n## literal\n```"), {
    title: null,
    parts: [{ kind: "body", text: "```md\n## literal\n```" }],
  });
});
