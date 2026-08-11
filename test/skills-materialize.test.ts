import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import type { SkillFile, SkillResolution } from "../src/skills/skill-store.ts";
import {
  createSkillMaterializer,
  materializeSkillIndex,
  materializeSkillTree,
  materializedContentDigests,
  safeSkillDirName,
} from "../src/skills/materialize.ts";
import { computeBundleHash, type SkillBundle } from "../src/skills/skill-bundle-store.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";

const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };

function res(name: string, body: string, files: SkillFile[] = [], packId?: string): SkillResolution {
  return {
    skill: {
      manifest: { name, body, files },
      ...(packId ? { pack: { packId, commit: "c", upstreamName: name } } : {}),
    },
    shadowed: [],
  } as unknown as SkillResolution;
}

function bundle(packId: string, files: SkillFile[]): SkillBundle {
  return { packId, commit: "c", files, hash: computeBundleHash(files) };
}

function fakeSandbox() {
  const files = new Map<string, string>();
  const calls = { reads: 0, writes: 0, removes: 0 };
  const sandbox = {
    async readFile(_h: SandboxHandle, rel: string) {
      calls.reads++;
      return files.has(rel) ? files.get(rel)! : null;
    },
    async writeFile(_h: SandboxHandle, rel: string, data: string) {
      calls.writes++;
      files.set(rel, data);
    },
    async removeDir(_h: SandboxHandle, rel: string) {
      calls.removes++;
      for (const k of files.keys()) if (k === rel || k.startsWith(`${rel}/`)) files.delete(k);
    },
  } as unknown as Sandbox;
  return { sandbox, files, calls };
}

test("materialized skill directory names are validated and never lossy", () => {
  assert.equal(safeSkillDirName("foo-bar_v1.2"), "foo-bar_v1.2");
  assert.throws(() => safeSkillDirName("foo/bar"), /skill name must/);
  assert.throws(() => safeSkillDirName(".."), /skill name must/);
});

test("materializeSkillIndex lays only each SKILL.md body + an index marker", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillIndex(sandbox, handle, [res("alpha", "A"), res("beta", "B")]);

  assert.equal(files.get("skills/alpha/SKILL.md"), "A");
  assert.equal(files.get("skills/beta/SKILL.md"), "B");
  assert.ok(files.has("skills/.index"), "an index marker is written");
  assert.equal(calls.writes, 3, "2 SKILL.md bodies + 1 marker — no asset writes");
});

test("materializeSkillIndex does NOT lay a skill's asset tree (that's lazy)", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillIndex(sandbox, handle, [
    res("gamma", "G", [{ path: "scripts/hello.py", content: "print('hi')" }]),
  ]);

  assert.equal(files.get("skills/gamma/SKILL.md"), "G", "the body is eager");
  assert.equal(files.has("skills/gamma/scripts/hello.py"), false, "the asset is NOT laid until first read");
});

test("materializeSkillIndex SKIPS when the body set is unchanged (order-independent)", async () => {
  const { sandbox, calls } = fakeSandbox();
  await materializeSkillIndex(sandbox, handle, [res("alpha", "A"), res("beta", "B")]);
  const writes = calls.writes;

  await materializeSkillIndex(sandbox, handle, [res("beta", "B"), res("alpha", "A")]);
  assert.equal(calls.writes, writes, "no rewrite on a matching body set");
});

test("materializeSkillIndex re-lays when a body changes", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillIndex(sandbox, handle, [res("alpha", "A")]);
  const writes = calls.writes;
  await materializeSkillIndex(sandbox, handle, [res("alpha", "A2")]);
  assert.ok(calls.writes > writes, "a changed body busts the index marker");
  assert.equal(files.get("skills/alpha/SKILL.md"), "A2");
});

test("materializeSkillIndex does NOT re-lay when only an asset changes (asset is not in the index hash)", async () => {
  const { sandbox, calls } = fakeSandbox();
  await materializeSkillIndex(sandbox, handle, [res("gamma", "G", [{ path: "s.py", content: "v1" }])]);
  const writes = calls.writes;
  await materializeSkillIndex(sandbox, handle, [res("gamma", "G", [{ path: "s.py", content: "v2" }])]);
  assert.equal(calls.writes, writes, "asset-only change doesn't touch the eager index");
});

test("materializeSkillIndex removes an archived skill's materialized tree", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  const alpha = res("alpha", "A", [{ path: "asset.txt", content: "asset" }]);
  await materializeSkillIndex(sandbox, handle, [alpha]);
  await materializeSkillTree(sandbox, handle, alpha, [bundle("p", [{ path: "lib/alpha.mjs", content: "shared" }])]);

  await materializeSkillIndex(sandbox, handle, []);
  assert.equal(files.has("skills/alpha/SKILL.md"), false);
  assert.equal(files.has("skills/alpha/asset.txt"), false);
  assert.equal(files.has("lib/alpha.mjs"), false);

  const removes = calls.removes;
  await materializeSkillIndex(sandbox, handle, []);
  assert.equal(calls.removes, removes, "the reconciled marker makes the next pass idempotent");
});

test("materializeSkillIndex migrates a legacy hash marker without retaining old skill paths", async () => {
  const { sandbox, files } = fakeSandbox();
  const alpha = res("alpha", "A");
  await materializeSkillIndex(sandbox, handle, [alpha]);
  const state = JSON.parse(files.get("skills/.index")!) as { hash: string };
  files.set("skills/.index", state.hash);
  files.set("skills/removed/SKILL.md", "removed");
  files.set("skills/removed/asset.txt", "stale");

  await materializeSkillIndex(sandbox, handle, [alpha]);
  assert.equal(files.has("skills/removed/SKILL.md"), false);
  assert.equal(files.has("skills/removed/asset.txt"), false);
  assert.equal(files.get("skills/alpha/SKILL.md"), "A");
  const migrated = JSON.parse(files.get("skills/.index")!);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.treesComplete, true);
  assert.equal(migrated.legacyExternalPathsPreserved, true);
});

test("legacy migration cleans the managed skills namespace but preserves unknown external files", async () => {
  const { sandbox, files } = fakeSandbox();
  const alpha = res("alpha", "A");
  const currentBundle = bundle("p", [{ path: "lib/current.mjs", content: "current" }]);
  await materializeSkillIndex(sandbox, handle, [alpha]);
  await materializeSkillTree(sandbox, handle, alpha, [currentBundle]);
  const index = JSON.parse(files.get("skills/.index")!) as { hash: string };
  files.set("skills/.index", index.hash);
  files.set("skills/removed/stale.txt", "provably managed");
  files.set("skills/.packs/p/lib/current.mjs", "stale known content");
  files.set("lib/unknown-pre-v1.mjs", "ownership unknowable");

  await materializeSkillIndex(sandbox, handle, [alpha]);
  await materializeSkillTree(sandbox, handle, alpha, [currentBundle]);
  assert.equal(files.has("skills/removed/stale.txt"), false);
  assert.equal(
    files.get("skills/.packs/p/lib/current.mjs"),
    "current",
    "the current bundle proves ownership and is reconciled",
  );
  assert.equal(files.get("lib/unknown-pre-v1.mjs"), "ownership unknowable");
  assert.equal(JSON.parse(files.get("skills/.index")!).legacyExternalPathsPreserved, true);

  await materializeSkillIndex(sandbox, handle, [res("alpha", "A2")]);
  assert.equal(
    JSON.parse(files.get("skills/.index")!).legacyExternalPathsPreserved,
    true,
    "the incomplete legacy inventory is never silently declared complete",
  );
});

test("materializeSkillTree lays the asset tree + a per-skill marker", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(
    sandbox,
    handle,
    res("gamma", "G", [
      { path: "scripts/hello.py", content: "print('hi')", executable: true },
      { path: "references/notes.md", content: "# notes" },
    ]),
  );

  assert.equal(files.get("skills/gamma/SKILL.md"), "G", "SKILL.md is re-laid as part of the tree");
  assert.equal(files.get("skills/gamma/scripts/hello.py"), "print('hi')");
  assert.equal(files.get("skills/gamma/references/notes.md"), "# notes");
  assert.ok(files.has("skills/gamma/.tree"), "a per-skill tree marker is written");
});

test("materializeSkillTree records and skips a clean body-only tree", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("alpha", "A"));
  assert.equal(files.get("skills/alpha/SKILL.md"), "A");
  assert.equal(files.has("skills/alpha/.tree"), true);
  const writes = calls.writes;
  await materializeSkillTree(sandbox, handle, res("alpha", "A"));
  assert.equal(calls.writes, writes);
});

test("materializeSkillTree SKIPS when the tree is unchanged", async () => {
  const { sandbox, calls } = fakeSandbox();
  const skill = res("gamma", "G", [{ path: "s.py", content: "v1" }]);
  await materializeSkillTree(sandbox, handle, skill);
  const writes = calls.writes;
  await materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v1" }]));
  assert.equal(calls.writes, writes, "no rewrite when the tree is identical");
});

test("materializeSkillTree re-lays when an asset changes, and clears a removed asset", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillTree(
    sandbox,
    handle,
    res("gamma", "G", [
      { path: "a.py", content: "A" },
      { path: "b.py", content: "B" },
    ]),
  );
  const writes = calls.writes;

  await materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "a.py", content: "A2" }]));
  assert.ok(calls.writes > writes, "a changed tree re-lays");
  assert.equal(files.get("skills/gamma/a.py"), "A2");
  assert.equal(files.has("skills/gamma/b.py"), false, "a removed asset is cleared (dir cleared before re-lay)");
});

test("materializeSkillTree migrates a legacy hash marker by clearing stale pre-upgrade assets", async () => {
  const { sandbox, files } = fakeSandbox();
  const before = res("gamma", "G", [{ path: "old.py", content: "old" }]);
  await materializeSkillTree(sandbox, handle, before);
  const state = JSON.parse(files.get("skills/gamma/.tree")!) as { hash: string };
  files.set("skills/gamma/.tree", state.hash);
  files.set("skills/gamma/untracked.py", "stale");

  await materializeSkillTree(sandbox, handle, res("gamma", "G2", [{ path: "new.py", content: "new" }]));
  assert.equal(files.has("skills/gamma/old.py"), false);
  assert.equal(files.has("skills/gamma/untracked.py"), false);
  assert.equal(files.get("skills/gamma/new.py"), "new");
  assert.equal(JSON.parse(files.get("skills/gamma/.tree")!).version, 2);
});

test("materializeSkillTree clears stale assets when its marker was deleted", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "old.py", content: "old" }]));
  files.delete("skills/gamma/.tree");

  await materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "new.py", content: "new" }]));
  assert.equal(files.has("skills/gamma/old.py"), false);
  assert.equal(files.get("skills/gamma/new.py"), "new");
});

test("materializeSkillTree clears stale assets after marker deletion when the skill becomes body-only", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "old.py", content: "old" }]));
  files.delete("skills/gamma/.tree");

  await materializeSkillTree(sandbox, handle, res("gamma", "G"));
  assert.equal(files.has("skills/gamma/old.py"), false);
  assert.equal(files.get("skills/gamma/SKILL.md"), "G");
  assert.equal(files.has("skills/gamma/.tree"), true);
});

test("materializeSkillTree SKIPS when only file ordering differs", async () => {
  const { sandbox, calls } = fakeSandbox();
  const a: SkillFile = { path: "a.py", content: "A" };
  const b: SkillFile = { path: "b.py", content: "B" };
  await materializeSkillTree(sandbox, handle, res("gamma", "G", [a, b]));
  const writes = calls.writes;
  await materializeSkillTree(sandbox, handle, res("gamma", "G", [b, a]));
  assert.equal(calls.writes, writes, "reordered files are the same set — no rewrite");
});

test("materialization serializes concurrent mutations for the same sandbox handle", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v1" }]));
  const originalWrite = sandbox.writeFile.bind(sandbox);
  let entered!: () => void;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unblocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  sandbox.writeFile = async (h, path, data) => {
    if (path === "skills/gamma/s.py" && data === "v2") {
      entered();
      await unblocked;
    }
    await originalWrite(h, path, data);
  };

  const second = materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v2" }]));
  await blocked;
  const readsWhileBlocked = calls.reads;
  const third = materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v3" }]));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    calls.reads,
    readsWhileBlocked,
    "the later mutation has not probed stale state while the first is in flight",
  );
  release();
  await Promise.all([second, third]);
  assert.equal(files.get("skills/gamma/s.py"), "v3", "invocation order determines the final tree");
});

test("fleet lock serializes materializers from separate process instances", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  const fleetLock = createMemoryAdvisoryLock();
  const instanceA = createSkillMaterializer(fleetLock);
  const instanceB = createSkillMaterializer(fleetLock);
  await instanceA.materializeTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v1" }]));

  const originalWrite = sandbox.writeFile.bind(sandbox);
  let entered!: () => void;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unblocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  sandbox.writeFile = async (h, path, data) => {
    if (path === "skills/gamma/s.py" && data === "v2") {
      entered();
      await unblocked;
    }
    await originalWrite(h, path, data);
  };

  const oldLay = instanceA.materializeTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v2" }]));
  await blocked;
  const readsWhileBlocked = calls.reads;
  const newLay = instanceB.materializeTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v3" }]));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    calls.reads,
    readsWhileBlocked,
    "the second process cannot probe while the first process mutates the projection",
  );

  release();
  await Promise.all([oldLay, newLay]);
  assert.equal(files.get("skills/gamma/s.py"), "v3");
});

test("fresh reconciliation prevents an older turn from regressing a newer projection", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  const fleetLock = createMemoryAdvisoryLock();
  const newerTurn = createSkillMaterializer(fleetLock);
  const olderTurn = createSkillMaterializer(fleetLock);
  const current = res("gamma", "G3", [{ path: "s.py", content: "v3" }]);

  await newerTurn.materializeIndex(sandbox, handle, [current], async () => [current]);
  await newerTurn.materializeTree(sandbox, handle, current, [], async () => ({ resolution: current, bundles: [] }));
  const removes = calls.removes;

  await olderTurn.materializeIndex(sandbox, handle, [], async () => [current]);
  await olderTurn.materializeTree(
    sandbox,
    handle,
    res("gamma", "G2", [{ path: "s.py", content: "v2" }]),
    [],
    async () => ({ resolution: current, bundles: [] }),
  );

  assert.equal(files.get("skills/gamma/SKILL.md"), "G3");
  assert.equal(files.get("skills/gamma/s.py"), "v3");
  assert.equal(calls.removes, removes, "the stale empty index does not delete the current skill tree");
});

test("materializeSkillTree confines a pack's shared bundle below its pack root", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("gmail", "G", [], "s1"), [
    bundle("s1", [
      { path: "lib/cite.mjs", content: "cite" },
      { path: "skills/conventions/quality.md", content: "q" },
    ]),
  ]);
  assert.match(files.get("skills/gmail/SKILL.md") ?? "", /skills\/\.packs\/s1/);
  assert.equal(files.get("skills/.packs/s1/lib/cite.mjs"), "cite");
  assert.equal(files.get("skills/.packs/s1/skills/conventions/quality.md"), "q");
  assert.equal(files.get("lib/cite.mjs"), undefined, "pack bytes never overwrite the workspace root");
});

test("materializeSkillTree never lays bundle content over core marker paths", async () => {
  const { sandbox, files } = fakeSandbox();
  const alpha = res("alpha", "A");
  const beta = res("beta", "B");
  await materializeSkillIndex(sandbox, handle, [alpha, beta]);
  files.set("keep.txt", "valuable");
  const forged = JSON.stringify({
    version: 1,
    hash: "forged",
    skillPaths: ["skills/alpha/SKILL.md"],
    bundlePaths: ["keep.txt"],
  });

  await materializeSkillTree(sandbox, handle, beta, [
    bundle("evil", [
      { path: "skills/.index", content: forged },
      { path: "skills/alpha/.tree", content: forged },
    ]),
  ]);
  await materializeSkillTree(sandbox, handle, alpha);

  assert.equal(files.get("keep.txt"), "valuable");
  assert.notEqual(files.get("skills/.index"), forged);
  assert.notEqual(files.get("skills/alpha/.tree"), forged);
});

test("materializeSkillTree never trusts a pre-hardening JSON delete manifest", async () => {
  const { sandbox, files } = fakeSandbox();
  const alpha = res("alpha", "A");
  await materializeSkillIndex(sandbox, handle, [alpha]);
  files.set("keep.txt", "valuable");
  files.set(
    "skills/alpha/.tree",
    JSON.stringify({
      version: 1,
      hash: "forged",
      skillPaths: ["skills/alpha/SKILL.md"],
      bundlePaths: ["keep.txt"],
    }),
  );

  await materializeSkillTree(sandbox, handle, alpha);

  assert.equal(files.get("keep.txt"), "valuable");
  assert.equal(JSON.parse(files.get("skills/alpha/.tree")!).version, 2);
});

test("materializeSkillTree re-lays when only a shared bundle file changes", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("gmail", "G"), [
    bundle("s1", [{ path: "lib/cite.mjs", content: "v1" }]),
  ]);
  const writes = calls.writes;
  await materializeSkillTree(sandbox, handle, res("gmail", "G"), [
    bundle("s1", [{ path: "lib/cite.mjs", content: "v2" }]),
  ]);
  assert.ok(calls.writes > writes, "a changed shared file busts the tree key even when no asset changed");
  assert.equal(files.get("skills/.packs/s1/lib/cite.mjs"), "v2");
});

test("materializeSkillTree removes stale bundle paths but preserves another current owner's paths", async () => {
  const { sandbox, files } = fakeSandbox();
  const alpha = res("alpha", "A");
  const beta = res("beta", "B");
  await materializeSkillIndex(sandbox, handle, [alpha, beta]);
  await materializeSkillTree(sandbox, handle, beta, [
    bundle("shared-pack", [{ path: "lib/shared.mjs", content: "shared" }]),
  ]);
  await materializeSkillTree(sandbox, handle, alpha, [
    bundle("shared-pack", [
      { path: "lib/shared.mjs", content: "shared" },
      { path: "lib/stale.mjs", content: "stale" },
    ]),
  ]);

  await materializeSkillTree(sandbox, handle, alpha);
  assert.equal(
    files.get("skills/.packs/shared-pack/lib/shared.mjs"),
    "shared",
    "a current owner's claim protects the shared path",
  );
  assert.equal(files.has("skills/.packs/shared-pack/lib/stale.mjs"), false, "an unclaimed old bundle path is removed");
  assert.equal(files.get("skills/alpha/SKILL.md"), "A");
  assert.equal(files.has("skills/alpha/.tree"), true, "the clean body-only projection remains idempotent");
});

test("materializeSkillTree uses extractFiles (one batch) when the backend offers it", async () => {
  const { sandbox, files } = fakeSandbox();
  let batches = 0;
  (sandbox as unknown as { extractFiles: Sandbox["extractFiles"] }).extractFiles = async (_h, entries) => {
    batches++;
    for (const e of entries) files.set(e.path, Buffer.from(e.data).toString("utf8"));
  };
  await materializeSkillTree(
    sandbox,
    handle,
    res("gamma", "G", [
      { path: "a.py", content: "A" },
      { path: "b.py", content: "B" },
    ]),
  );
  assert.equal(batches, 1, "the whole tree is laid in a single round-trip");
  assert.equal(files.get("skills/gamma/a.py"), "A");
  assert.equal(files.get("skills/gamma/b.py"), "B");
});

test("materializeSkillIndex performs O(1) sandbox reads regardless of skill count", async () => {
  const { sandbox, calls } = fakeSandbox();
  const many = Array.from({ length: 20 }, (_, i) => res(`s${i}`, "B", [{ path: "a.txt", content: "x" }]));
  await materializeSkillIndex(sandbox, handle, many);
  assert.equal(calls.reads, 1, "a cold index materialization reads only the index marker");

  await materializeSkillIndex(sandbox, handle, many.slice(1));
  assert.equal(calls.reads, 2, "a reconcile that removes a skill still reads only the index marker");

  await materializeSkillIndex(sandbox, handle, many.slice(1));
  assert.equal(calls.reads, 3, "the fresh check is a single index read");
});

test("materializeSkillTree performs O(1) sandbox reads regardless of sibling count", async () => {
  const { sandbox, calls } = fakeSandbox();
  const alpha = res("alpha", "A", [{ path: "a.txt", content: "1" }]);
  const siblings = Array.from({ length: 20 }, (_, i) => res(`o${i}`, "O", [{ path: "b.txt", content: "y" }]));
  await materializeSkillIndex(sandbox, handle, [alpha, ...siblings]);
  for (const s of siblings) await materializeSkillTree(sandbox, handle, s);

  const before = calls.reads;
  await materializeSkillTree(sandbox, handle, alpha);
  assert.equal(calls.reads - before, 2, "one tree-marker read + one index read, no per-sibling probes");
});

test("v2 index state migrates by probing per-name tree markers once, then never again", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  const alpha = res("alpha", "A");
  const beta = res("beta", "B");
  const shared = bundle("shared", [
    { path: "lib/shared.mjs", content: "s" },
    { path: "lib/beta.mjs", content: "b" },
  ]);
  await materializeSkillIndex(sandbox, handle, [alpha, beta]);
  await materializeSkillTree(sandbox, handle, alpha, [bundle("shared", [{ path: "lib/shared.mjs", content: "s" }])]);
  await materializeSkillTree(sandbox, handle, beta, [shared]);

  const written = JSON.parse(files.get("skills/.index")!);
  files.set("skills/.index", JSON.stringify({ version: 2, hash: written.hash, names: written.names }));

  const before = calls.reads;
  await materializeSkillIndex(sandbox, handle, [alpha]);
  assert.equal(
    calls.reads - before,
    3,
    "the v2 migration reads the index once plus one tree-marker probe per known name",
  );

  assert.equal(
    files.get("skills/.packs/shared/lib/shared.mjs"),
    "s",
    "a bundle path still owned by a surviving skill survives the migration",
  );
  assert.equal(files.has("skills/.packs/shared/lib/beta.mjs"), false, "an unowned bundle path is removed");
  assert.equal(files.has("skills/beta/SKILL.md"), false, "the removed skill's tree is cleaned");

  const migrated = JSON.parse(files.get("skills/.index")!);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.treesComplete, true);
  assert.deepEqual(migrated.names, ["alpha"]);
  assert.deepEqual(migrated.skills.alpha.bundlePaths, ["skills/.packs/shared/lib/shared.mjs"]);
  assert.equal(migrated.skills.beta, undefined, "the removed skill leaves no folded tree state");

  const steady = calls.reads;
  await materializeSkillIndex(sandbox, handle, [res("alpha", "A2")]);
  assert.equal(calls.reads - steady, 1, "post-migration reconciles are probe-free");
  assert.equal(
    files.get("skills/.packs/shared/lib/shared.mjs"),
    "s",
    "the folded tree state protects the shared bundle across later reconciles",
  );

  const treeReads = calls.reads;
  await materializeSkillTree(sandbox, handle, res("alpha", "A2"), [
    bundle("shared", [{ path: "lib/shared.mjs", content: "s" }]),
  ]);
  assert.equal(calls.reads - treeReads, 2, "a post-migration tree rewrite does only the constant reads");
  assert.equal(
    files.get("skills/.packs/shared/lib/shared.mjs"),
    "s",
    "a bundle path owned by the folded v3 state survives a tree rewrite",
  );
});

test("current() re-resolution keeps the folded index tree entries in step with the latest projection", async () => {
  const { sandbox, files } = fakeSandbox();
  const fleetLock = createMemoryAdvisoryLock();
  const materializer = createSkillMaterializer(fleetLock);
  const stale = res("gamma", "G2", [{ path: "s.py", content: "v2" }]);
  const current = res("gamma", "G3", [{ path: "s.py", content: "v3" }]);

  await materializer.materializeIndex(sandbox, handle, [stale], async () => [current]);
  await materializer.materializeTree(sandbox, handle, stale, [], async () => ({ resolution: current, bundles: [] }));

  assert.equal(files.get("skills/gamma/SKILL.md"), "G3");
  assert.equal(files.get("skills/gamma/s.py"), "v3");
  const index = JSON.parse(files.get("skills/.index")!);
  const tree = JSON.parse(files.get("skills/gamma/.tree")!);
  assert.equal(index.version, 3);
  assert.equal(index.skills.gamma.hash, tree.hash, "the folded index entry mirrors the materialized tree state");
  assert.deepEqual(index.skills.gamma.skillPaths, ["skills/gamma/SKILL.md", "skills/gamma/s.py"]);
});

test("materializedContentDigests covers skill bodies, files, and bundle files — and nothing else", () => {
  const skills = [
    res("alpha", "alpha body", [{ path: "tool.py", content: "print(1)" }]),
    res("packed", "packed body", [], "pack-1"),
  ];
  const bundles = [bundle("pack-1", [{ path: "shared.md", content: "shared content" }])];
  const digests = materializedContentDigests(skills, bundles);
  const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  assert.ok(digests.has(sha("alpha body")));
  assert.ok(digests.has(sha("print(1)")));
  assert.ok(digests.has(sha("packed body\n\n## Pack files\nResolve repository-relative shared-file paths against `skills/.packs/pack-1/`; pack files never overwrite the workspace root.")));
  assert.ok(digests.has(sha("shared content")));
  assert.ok(!digests.has(sha("attacker planted this")));
  assert.ok(!digests.has(sha("alpha body ")), "byte-exact match required, not a prefix/trimmed match");
});
