// WS-V3 tests — offline, fetch stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  emitSkillDiff, emitProcessOutput, emitPromptRewrite,
  sign, truncate, profileSlug, sha1Hex,
  _setFetch, _clearDedup,
} from '../src/emit-units.js';

// Fixture profile: write fake creds to a temp HOME, install before tests.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-emit-test-'));
fs.mkdirSync(path.join(TMP_HOME, '.secrets'), { recursive: true });
fs.writeFileSync(path.join(TMP_HOME, '.secrets', 'panel-emit-opencode-atlas.txt'), 'fake-secret-12345');
fs.writeFileSync(path.join(TMP_HOME, '.secrets', 'panel-emit-opencode-atlas.key'), 'pk_test_FAKE_KEY');
process.env.HOME = TMP_HOME;

function stubFetch() {
  const calls = [];
  _setFetch(async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ ok: true, accepted: 1, ids: ['u_test'] }); },
    };
  });
  return calls;
}

test('signing produces lowercase hex sha256', () => {
  const sig = sign('s', 'body');
  assert.match(sig, /^[0-9a-f]{64}$/);
  const ref = crypto.createHmac('sha256', 's').update('body', 'utf8').digest('hex');
  assert.equal(sig, ref);
});

test('truncate caps at limit', () => {
  assert.equal(truncate('abcdef', 3), 'abc');
  assert.equal(truncate('ab', 5), 'ab');
  assert.equal(truncate(null, 3), null);
});

test('profileSlug lowercases and replaces :', () => {
  assert.equal(profileSlug('opencode:Atlas'), 'opencode-atlas');
  assert.equal(profileSlug('hermes:machine-smart'), 'hermes-machine-smart');
});

test('env gate off → returns disabled', async () => {
  delete process.env.PANEL_EMIT_ENABLED;
  _clearDedup();
  const calls = stubFetch();
  const r = await emitSkillDiff({ skillName: 's', diff: 'd', reason: 'r' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(calls.length, 0);
});

test('env gate on → posts + signs', async () => {
  process.env.PANEL_EMIT_ENABLED = '1';
  _clearDedup();
  const calls = stubFetch();
  const r = await emitSkillDiff({ skillName: 'sk1', diff: 'diff body', reason: 'why' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  const { url, opts } = calls[0];
  assert.match(url, /\/api\/units\/ingest$/);
  assert.equal(opts.headers['X-Panel-Site-Key'], 'pk_test_FAKE_KEY');
  assert.match(opts.headers['X-Panel-Ingest-Sig'], /^[0-9a-f]{64}$/);
  // Verify the sig matches what we'd compute over the exact body
  const expected = crypto.createHmac('sha256', 'fake-secret-12345').update(opts.body, 'utf8').digest('hex');
  assert.equal(opts.headers['X-Panel-Ingest-Sig'], expected);
  const parsed = JSON.parse(opts.body);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'skill_diff_review');
  assert.equal(parsed[0].source_agent, 'opencode:atlas');
});

test('dedup cache blocks repeat within window', async () => {
  process.env.PANEL_EMIT_ENABLED = '1';
  _clearDedup();
  const calls = stubFetch();
  const args = { skillName: 'sk-dedup', diff: 'd', reason: 'r' };
  const r1 = await emitSkillDiff(args);
  const r2 = await emitSkillDiff(args);
  assert.equal(r1.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(r2.deduped, true);
});

test('process_output shape + truncation', async () => {
  process.env.PANEL_EMIT_ENABLED = '1';
  _clearDedup();
  const calls = stubFetch();
  const longPassage = 'p'.repeat(10_000);
  const longGoal = 'g'.repeat(3_000);
  await emitProcessOutput({ passage: longPassage, userGoal: longGoal });
  const parsed = JSON.parse(calls[0].opts.body);
  assert.equal(parsed[0].type, 'process_output_rating');
  assert.equal(parsed[0].passage.length, 8000);
  assert.equal(parsed[0].prompt_context.length, 2000);
  assert.equal(parsed[0].choices.length, 4);
});

test('prompt_rewrite shape + truncation', async () => {
  process.env.PANEL_EMIT_ENABLED = '1';
  _clearDedup();
  const calls = stubFetch();
  const longOrig = 'a'.repeat(3_000);
  const longCorr = 'b'.repeat(3_000);
  await emitPromptRewrite({ original: longOrig, corrected: longCorr, context: 'ctx' });
  const parsed = JSON.parse(calls[0].opts.body);
  assert.equal(parsed[0].type, 'prompt_rewrite_pair');
  assert.equal(parsed[0].choices.length, 2);
  assert.equal(parsed[0].choices[0].text.length, 2000);
  assert.equal(parsed[0].choices[1].text.length, 2000);
});

test('external_ref is deterministic', () => {
  const a = sha1Hex('foo|bar').slice(0, 16);
  const b = sha1Hex('foo|bar').slice(0, 16);
  assert.equal(a, b);
  assert.equal(a.length, 16);
});

test('network failure fails open', async () => {
  process.env.PANEL_EMIT_ENABLED = '1';
  _clearDedup();
  _setFetch(async () => { throw new Error('boom'); });
  const r = await emitSkillDiff({ skillName: 'sk-net', diff: 'd', reason: 'r' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'boom');
});

test('missing profile creds returns reason, does not throw', async () => {
  process.env.PANEL_EMIT_ENABLED = '1';
  _clearDedup();
  const calls = stubFetch();
  const r = await emitSkillDiff({ skillName: 'sk-missing', diff: 'd', reason: 'r', profile: 'opencode:does-not-exist' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing credentials/);
  assert.equal(calls.length, 0);
});
