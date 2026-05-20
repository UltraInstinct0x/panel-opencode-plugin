// WS-V3: panel-opencode-plugin V1 unit-type emitters.
// Thin HMAC-signed POST to panel /api/units/ingest, one helper per V1 unit type.
// Reads per-profile site_key + secret from $HOME/.secrets/panel-emit-<slug>.{key,txt}.
// Env-gated on PANEL_EMIT_ENABLED=1. Fail-open. 30s in-mem dedup on external_ref.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DEFAULT_PROFILE = process.env.PANEL_OPENCODE_PROFILE || 'opencode:atlas';
const INGEST_URL = () => process.env.PANEL_INGEST_URL || 'https://panel.goku.codes/api/units/ingest';
const TIMEOUT_MS = 5_000;
const DEDUP_WINDOW_MS = 30_000;

let _fetch = (typeof fetch === 'function') ? fetch : null;
export function _setFetch(fn) { _fetch = fn; }

const _dedup = new Map(); // external_ref → expires_at_ms
export function _clearDedup() { _dedup.clear(); }

export function sha1Hex(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

export function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export function truncate(s, max) {
  if (s == null) return s;
  const str = String(s);
  return str.length > max ? str.slice(0, max) : str;
}

export function profileSlug(profile) {
  return String(profile).toLowerCase().replace(/:/g, '-');
}

function loadCreds(profile) {
  const slug = profileSlug(profile);
  const home = process.env.HOME || os.homedir();
  const dir = path.join(home, '.secrets');
  const keyPath = path.join(dir, `panel-emit-${slug}.key`);
  const secretPath = path.join(dir, `panel-emit-${slug}.txt`);
  if (!fs.existsSync(keyPath) || !fs.existsSync(secretPath)) {
    return { ok: false, reason: `missing credentials for profile ${profile}` };
  }
  return {
    ok: true,
    siteKey: fs.readFileSync(keyPath, 'utf8').trim(),
    secret: fs.readFileSync(secretPath, 'utf8').trim(),
  };
}

function isDedupHit(ref) {
  const now = Date.now();
  const exp = _dedup.get(ref);
  if (exp && exp > now) return true;
  // GC expired
  for (const [k, v] of _dedup) if (v <= now) _dedup.delete(k);
  return false;
}

function markDedup(ref) {
  _dedup.set(ref, Date.now() + DEDUP_WINDOW_MS);
}

async function postBatch(units, profile) {
  if (process.env.PANEL_EMIT_ENABLED !== '1') {
    return { ok: false, reason: 'disabled' };
  }
  if (!Array.isArray(units) || units.length === 0) {
    return { ok: true, accepted: 0 };
  }
  // dedup check (skip any whose external_ref is in window; emit the rest)
  const ext = units.map(u => u.external_ref).filter(Boolean);
  if (ext.length === units.length && ext.every(isDedupHit)) {
    return { ok: false, deduped: true, reason: 'dedup_window' };
  }

  const creds = loadCreds(profile);
  if (!creds.ok) return creds;

  const enriched = units.map(u => ({ source_agent: profile, ...u }));
  const body = JSON.stringify(enriched);
  const sig = sign(creds.secret, body);

  if (!_fetch) return { ok: false, reason: 'no_fetch_impl' };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await _fetch(INGEST_URL(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Panel-Site-Key': creds.siteKey,
        'X-Panel-Ingest-Sig': sig,
      },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (!res.ok) {
      return { ok: false, status: res.status, reason: parsed?.error || text.slice(0, 200) };
    }
    for (const u of enriched) if (u.external_ref) markDedup(u.external_ref);
    return { ok: true, ...(parsed || {}) };
  } catch (err) {
    console.error('[panel-emit-units] error:', err.message);
    return { ok: false, reason: err.message };
  } finally {
    clearTimeout(t);
  }
}

const RATING_CHOICES = [
  { label: '1', text: 'great' },
  { label: '2', text: 'ok' },
  { label: '3', text: 'meh' },
  { label: '4', text: 'bad' },
];

export async function emitSkillDiff({ skillName, diff, reason, profile = DEFAULT_PROFILE } = {}) {
  const unit = {
    type: 'skill_diff_review',
    external_ref: sha1Hex(`skill_diff_review|${skillName}|${reason || ''}`).slice(0, 16),
    diff: truncate(diff, 8000),
    prompt_context: truncate(reason, 2000),
    binary: { yes: 'improvement', no: 'regression' },
  };
  return postBatch([unit], profile);
}

export async function emitProcessOutput({ passage, userGoal, profile = DEFAULT_PROFILE } = {}) {
  const unit = {
    type: 'process_output_rating',
    external_ref: sha1Hex(`process_output_rating|${String(passage).slice(0, 500)}`).slice(0, 16),
    passage: truncate(passage, 8000),
    prompt_context: truncate(userGoal, 2000),
    choices: RATING_CHOICES,
  };
  return postBatch([unit], profile);
}

export async function emitPromptRewrite({ original, corrected, context, profile = DEFAULT_PROFILE } = {}) {
  const unit = {
    type: 'prompt_rewrite_pair',
    external_ref: sha1Hex(`prompt_rewrite_pair|${original}|${corrected}`).slice(0, 16),
    prompt_context: truncate(context, 2000),
    choices: [
      { label: 'A', text: truncate(original, 2000) },
      { label: 'B', text: truncate(corrected, 2000) },
    ],
  };
  return postBatch([unit], profile);
}
