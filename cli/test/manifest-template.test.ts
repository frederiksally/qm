import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfigAt } from "../src/config.ts";
import { renderSlackManifests } from "../src/slack-manifests.ts";

interface SlackManifest {
  features: { agent_view: { agent_description: string; suggested_prompts: Array<{ title: string; message: string }> } };
  oauth_config: { scopes: { bot: string[] } };
  settings: { event_subscriptions: { bot_events: string[] } };
}

const manifest = (url: URL): SlackManifest => JSON.parse(readFileSync(url, "utf8")) as SlackManifest;

test("the CLI Slack manifest template matches the plugin's scopes and events", () => {
  const template = manifest(new URL("../templates/slack-manifest.json", import.meta.url));
  const plugin = manifest(new URL("../../src/slack/manifest.json", import.meta.url));
  assert.deepEqual([...template.oauth_config.scopes.bot].sort(), [...plugin.oauth_config.scopes.bot].sort());
  assert.deepEqual(
    [...template.settings.event_subscriptions.bot_events].sort(),
    [...plugin.settings.event_subscriptions.bot_events].sort(),
  );
  assert.deepEqual(template.features, plugin.features);
  assert.ok(template.features.agent_view.agent_description.length > 0);
  assert.ok(
    template.features.agent_view.suggested_prompts.length >= 2 &&
      template.features.agent_view.suggested_prompts.length <= 4,
  );
  for (const prompt of template.features.agent_view.suggested_prompts) {
    assert.ok(prompt.title.length > 0);
    assert.ok(prompt.message.length > 0);
  }
});

test("the checked-in Acme Slack manifest matches a fresh render", () => {
  const configPath = fileURLToPath(new URL("../../deploy/stacks/acme/qm.config.jsonc", import.meta.url));
  const checkedIn = readFileSync(new URL("../../deploy/stacks/acme/slack-app-manifest.yml", import.meta.url), "utf8");
  assert.equal(checkedIn, renderSlackManifests(loadConfigAt(configPath).config).bot);
});
