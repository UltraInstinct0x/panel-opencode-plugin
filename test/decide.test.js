// Unit tests for the pure decision/util surface of panel-opencode-plugin.
// Run: node --test test/decide.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { decideForward } from "../src/index.js";

const CFG = {
  samplingRate: 0.05,
  noveltyThreshold: 0.7,
  maxMessages: 25,
};

test("force=true always forwards", () => {
  const d = decideForward({ messages: [], cfg: CFG, lru: [], force: true });
  assert.equal(d.forward, true);
  assert.equal(d.reason, "force");
});

test("error in any part forwards", () => {
  const messages = [
    { role: "user", parts: [{ type: "text", text: "do thing" }] },
    {
      role: "assistant",
      parts: [{ type: "tool", state: { status: "error", error: "boom" } }],
    },
  ];
  const d = decideForward({ messages, cfg: CFG, lru: [], rng: () => 0.99 });
  assert.equal(d.forward, true);
  assert.equal(d.reason, "error_flag");
});

test("novel content forwards even at low sample", () => {
  const lru = [new Set(["foo", "bar", "baz"])];
  const messages = [
    { role: "user", parts: [{ type: "text", text: "completely different vocabulary today" }] },
  ];
  const d = decideForward({ messages, cfg: CFG, lru, rng: () => 0.99 });
  assert.equal(d.forward, true);
  assert.equal(d.reason, "novelty");
});

test("repeat content not novel; baseline sample at 5% with rng=0.99 skips", () => {
  const tokens = new Set(["hello", "world", "again"]);
  const lru = [tokens];
  const messages = [
    { role: "user", parts: [{ type: "text", text: "hello world again" }] },
  ];
  const d = decideForward({ messages, cfg: CFG, lru, rng: () => 0.99 });
  assert.equal(d.forward, false);
  assert.equal(d.reason, "baseline");
});

test("baseline sample at 5% with rng=0.01 forwards as sample", () => {
  const tokens = new Set(["hello", "world", "again"]);
  const lru = [tokens];
  const messages = [
    { role: "user", parts: [{ type: "text", text: "hello world again" }] },
  ];
  const d = decideForward({ messages, cfg: CFG, lru, rng: () => 0.01 });
  assert.equal(d.forward, true);
  assert.equal(d.reason, "sample");
});

test("empty messages, empty lru → novelty 1.0, forwards as novelty", () => {
  const d = decideForward({ messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }], cfg: CFG, lru: [], rng: () => 0.99 });
  assert.equal(d.forward, true);
  assert.equal(d.reason, "novelty");
});
