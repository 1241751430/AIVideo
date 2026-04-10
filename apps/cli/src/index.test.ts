import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, parseDuration } from "./cli.js";

test("parseDuration understands second suffix", () => {
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("30"), 30);
});

test("parseArgs supports inline and positional arguments", () => {
  const parsed = parseArgs(["generate", "--theme", "新品发布", "--duration=45s", "--live"]);
  assert.deepEqual(parsed.command, ["generate"]);
  assert.equal(parsed.options.theme, "新品发布");
  assert.equal(parsed.options.duration, "45s");
  assert.equal(parsed.options.live, true);
});
