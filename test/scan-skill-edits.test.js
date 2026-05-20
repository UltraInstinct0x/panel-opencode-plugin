// V3-wire — scanSkillEdits: detect skill_manage tool calls in opencode session messages.

import { test } from "node:test";
import assert from "node:assert";
import { scanSkillEdits } from "../src/index.js";

test("returns [] for non-array input", () => {
  assert.deepEqual(scanSkillEdits(null), []);
  assert.deepEqual(scanSkillEdits(undefined), []);
  assert.deepEqual(scanSkillEdits("nope"), []);
});

test("returns [] when no skill_manage tool calls", () => {
  const msgs = [
    { role: "user", parts: [{ type: "text", text: "hi" }] },
    { role: "assistant", parts: [{ type: "tool", state: { tool: "bash", input: { cmd: "ls" } } }] },
  ];
  assert.deepEqual(scanSkillEdits(msgs), []);
});

test("detects skill_manage patch (state.tool shape)", () => {
  const msgs = [
    { role: "assistant", parts: [{
      type: "tool",
      state: {
        tool: "skill_manage",
        input: { action: "patch", name: "my-skill", old_string: "foo", new_string: "bar" },
      },
    }]},
  ];
  const out = scanSkillEdits(msgs);
  assert.equal(out.length, 1);
  assert.equal(out[0].skillName, "my-skill");
  assert.equal(out[0].reason, "patch");
  assert.match(out[0].diff, /--- old\nfoo/);
  assert.match(out[0].diff, /\+\+\+ new\nbar/);
});

test("detects skill_manage edit (alt p.tool/p.input shape)", () => {
  const msgs = [
    { role: "assistant", parts: [{
      type: "tool",
      tool: "skill_manage",
      input: { action: "edit", name: "x", content: "FULL SKILL.md\n---\nbody" },
    }]},
  ];
  const out = scanSkillEdits(msgs);
  assert.equal(out.length, 1);
  assert.equal(out[0].skillName, "x");
  assert.equal(out[0].reason, "edit");
  assert.match(out[0].diff, /FULL SKILL\.md/);
});

test("detects skill_manage create", () => {
  const msgs = [
    { role: "assistant", parts: [{
      type: "tool",
      state: { tool: "skill_manage", input: { action: "create", name: "new-one", content: "stub" } },
    }]},
  ];
  const out = scanSkillEdits(msgs);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, "create");
});

test("ignores delete/write_file actions", () => {
  const msgs = [
    { role: "assistant", parts: [{
      type: "tool",
      state: { tool: "skill_manage", input: { action: "delete", name: "old" } },
    }, {
      type: "tool",
      state: { tool: "skill_manage", input: { action: "write_file", name: "x", file_path: "y", file_content: "z" } },
    }]},
  ];
  assert.deepEqual(scanSkillEdits(msgs), []);
});

test("skips entries with empty skill name or empty diff", () => {
  const msgs = [
    { role: "assistant", parts: [{
      type: "tool",
      state: { tool: "skill_manage", input: { action: "patch", name: "", old_string: "a", new_string: "b" } },
    }, {
      type: "tool",
      state: { tool: "skill_manage", input: { action: "edit", name: "x", content: "" } },
    }]},
  ];
  assert.deepEqual(scanSkillEdits(msgs), []);
});

test("collects multiple edits across messages", () => {
  const msgs = [
    { parts: [{ type: "tool", state: { tool: "skill_manage", input: { action: "patch", name: "a", old_string: "1", new_string: "2" } } }] },
    { parts: [{ type: "tool", state: { tool: "skill_manage", input: { action: "create", name: "b", content: "x" } } }] },
  ];
  const out = scanSkillEdits(msgs);
  assert.equal(out.length, 2);
  assert.equal(out[0].skillName, "a");
  assert.equal(out[1].skillName, "b");
});
