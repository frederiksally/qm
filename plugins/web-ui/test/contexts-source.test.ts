import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");

test("contexts pane redraws preserve focus instead of raw-replacing the DOM", () => {
  assert.match(
    source,
    /render\(selected \? detailTpl\(selected\) : gridTpl\(\), host\);\s+replacePanePreservingFocus\(host\);/,
  );
  assert.doesNotMatch(source, /appState\.mainEl\.replaceChildren/);
});

test("contexts pane text inputs carry focus keys", () => {
  assert.match(source, /data-focus-key="project-member-search"/);
  assert.match(source, /data-focus-key="contexts-search"/);
  assert.match(source, /data-focus-key="project-name"/);
  assert.match(
    readFileSync(new URL("../src/ambient-policy.ts", import.meta.url), "utf8"),
    /data-focus-key="ambient-orders"/,
  );
});

test("member search commits the typed query to state on input", () => {
  const input = source.match(/<input\s+id="project-member-search"[^]*?\/>/)?.[0] ?? "";
  assert.match(
    input,
    /@input=\$\{[^]*?contextsState\.memberQuery = \(event\.currentTarget as HTMLInputElement\)\.value/,
  );
  assert.match(input, /\.value=\$\{contextsState\.memberQuery\}/);
});

test("member search runs debounced as you type", () => {
  const input = source.match(/<input\s+id="project-member-search"[^]*?\/>/)?.[0] ?? "";
  assert.match(input, /@input=\$\{[^]*?scheduleMemberSearch\(/);
  assert.match(source, /function scheduleMemberSearch\(/);
  assert.match(source, /clearTimeout\(memberSearchTimer\)/);
  assert.match(source, /memberSearchTimer = (?:window\.)?setTimeout\([^]*?MEMBER_SEARCH_DEBOUNCE_MS/);
});

test("submit and debounce share runMemberSearch", () => {
  assert.match(source, /async function runMemberSearch\(/);
  const submit = source.match(/async function searchProjectMembers\([^]*?\n\}/)?.[0] ?? "";
  assert.match(submit, /runMemberSearch\(/);
});

test("no-match searches render visible feedback", () => {
  assert.match(source, /memberSearchedQuery/);
  assert.match(source, /No matches for/);
  assert.match(source, /already in this project/);
});

test("dismissing the picker cancels a pending debounced search", () => {
  for (const fn of ["closeMemberPicker", "toggleMemberPicker", "selectContext", "addProjectMember"]) {
    const body = source.match(new RegExp(`function ${fn}\\([^]*?\\n\\}`))?.[0] ?? "";
    assert.match(body, /cancelMemberSearchTimer\(\)/, `${fn} must cancel the debounce timer`);
  }
});

test("typing supersedes an in-flight search", () => {
  const sched = source.match(/function scheduleMemberSearch\([^]*?\n\}/)?.[0] ?? "";
  assert.match(sched, /memberSearchSeq\+\+/);
  assert.match(sched, /memberSearching = false/);
});

test("result cap applies after the member filter", () => {
  assert.match(source, /\.filter\(\(match\) => !members\.has\(match\.principalId\)\)\.slice\(0, 8\)/);
});

test("every project member can invite while only the owner can remove people", () => {
  const detail = source.match(/function detailTpl\([^]*?\n\}/)?.[0] ?? "";
  const members = source.match(/function projectMembersSection\([^]*?\n\}/)?.[0] ?? "";
  assert.match(detail, /\$\{\s*c\.project\s*\? html`<button class="btn context-add-member"/);
  assert.doesNotMatch(detail, /c\.project && isProjectOwner\(c\)/);
  assert.match(members, /isProjectOwner\(context\) && principalId !== project\.ownerId/);
});

test("a project deep link that cannot be resolved says so instead of silently listing projects", () => {
  const open = source.match(/export async function openProjectDeepLink\([^]*?\n\}/)?.[0] ?? "";
  assert.match(open, /resolveProjectScope\(await ensureContexts\(\), slug\)/);
  assert.match(open, /unresolvedProject = slug/, "an unresolved link is remembered, not dropped");
  assert.match(open, /unresolvedProject = null/, "resolving clears the pending link");

  const grid = source.match(/function gridTpl\(\)[^]*?\n\}/)?.[0] ?? "";
  assert.match(grid, /unresolvedProject \? unresolvedProjectNotice\(unresolvedProject\) : ""/);
  assert.match(source, /isn't available to you yet/);
});

test("a refresh retries the pending project link, and opening a project clears it", () => {
  const renderFn = source.match(/export async function renderContexts\([^]*?\n\}/)?.[0] ?? "";
  assert.match(renderFn, /if \(unresolvedProject\) await openProjectDeepLink\(unresolvedProject\)/);
  const select = source.match(/function selectContext\([^]*?\n\}/)?.[0] ?? "";
  assert.match(select, /unresolvedProject = null/);
  const reset = source.match(/export function resetContextsState\([^]*?\n\}/)?.[0] ?? "";
  assert.match(reset, /unresolvedProject = null/);
});

test("the address bar keeps an unresolved project link so a reload can retry it", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const sync = shell.match(/export function syncUrlFromState\(\)[^]*?\n\}/)?.[0] ?? "";
  assert.match(
    sync,
    /if \(unresolvedProjectLink\(\) && !contextsState\.selected && PROJECT_SCOPED_VIEWS\.has\(appState\.currentView\)\) return;/,
  );
  assert.match(shell, /const PROJECT_SCOPED_VIEWS = new Set<View>\(\["contexts", "files", "deploys"\]\)/);
});
