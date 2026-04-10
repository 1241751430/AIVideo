import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "@aivideo/core";
import { createProviderSelection, testProviders } from "./index.js";

test("createProviderSelection returns default local providers", () => {
  const config = loadConfig(process.cwd());
  const providers = createProviderSelection(config, "default");
  assert.equal(providers.text?.id, "local-rule-text");
  assert.equal(providers.image?.id, "noop-image");
});

test("testProviders reports health for configured profile", async () => {
  const config = loadConfig(process.cwd());
  const health = await testProviders(config, "default");
  assert.equal(health.length, 4);
  assert.ok(health.some((item) => item.providerId === "local-rule-text"));
});
