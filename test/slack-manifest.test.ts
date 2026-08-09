import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

test("membership events invalidate the pushed authorization roster", async () => {
  const manifest = JSON.parse(await readFile(new URL("../src/slack/manifest.json", import.meta.url), "utf8")) as {
    settings?: { event_subscriptions?: { bot_events?: string[] } };
  };
  const events = manifest.settings?.event_subscriptions?.bot_events ?? [];
  assert.ok(events.includes("member_joined_channel"));
  assert.ok(events.includes("member_left_channel"));
});

test("the bot asks for no scope that would let it rewrite a conversation's description or topic", async () => {
  const forbidden = ["channels:manage", "groups:write"];
  for (const path of ["../src/slack/manifest.json", "../cli/templates/slack-manifest.json"]) {
    const manifest = JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as {
      oauth_config?: { scopes?: { bot?: string[] } };
    };
    const scopes = manifest.oauth_config?.scopes?.bot ?? [];
    assert.ok(scopes.length > 0, `${path} declares bot scopes`);
    for (const scope of forbidden) {
      assert.ok(!scopes.includes(scope), `${path} must not request ${scope}`);
    }
  }
  const stack = await readFile(new URL("../deploy/stacks/acme/slack-app-manifest.yml", import.meta.url), "utf8");
  for (const scope of forbidden) {
    assert.ok(!stack.includes(scope), `the example stack manifest must not request ${scope}`);
  }
});

test("Agent View uses the app home event contract", async () => {
  const manifest = JSON.parse(await readFile(new URL("../src/slack/manifest.json", import.meta.url), "utf8")) as {
    settings?: { event_subscriptions?: { bot_events?: string[] } };
  };
  const events = manifest.settings?.event_subscriptions?.bot_events ?? [];
  assert.ok(events.includes("app_home_opened"));
  assert.ok(!events.includes("assistant_thread_started"));
  assert.ok(!events.includes("assistant_thread_context_changed"));
});
