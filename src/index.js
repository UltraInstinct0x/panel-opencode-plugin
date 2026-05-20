// panel-opencode-plugin
// ─────────────────────
// Forward a sampled subset of opencode session traces to a `panel` ingest
// endpoint so they can be picked up for human judging (captcha-shape feedback
// loop / rater pool).
//
// Mirrors the hermes plugin (panel_trace_forwarder) behaviour:
//   * baseline rate 5% of session-idle events
//   * always-forward if: any tool/session error in the trace, or novel turn
//     (jaccard < 0.3 vs LRU of recently-shipped sessions)
//   * fire-and-forget (does not block the agent loop)
//   * circuit breaker: 3x non-2xx in 60s → opens for 5min
//   * scrubber-proxy in front of panel (post body, get attestation header)
//
// Config (opencode.json -> "plugin" entry options, or env):
//   panelUrl          str   http://127.0.0.1:3015
//   scrubberUrl       str   http://127.0.0.1:3017   (set to '' to disable)
//   siteKey           str   pk_test_thirdparty
//   sourceAgent       str   "opencode"
//   samplingRate      float 0.05 (capped at 0.25 unless override)
//   samplingRateOverride bool false
//   noveltyThreshold  float 0.7 (= 1 - jaccard_max)
//   lruSize           int   200
//   maxMessages       int   25  (cap messages in blob to keep payload sane)
//
// Env overrides:
//   PANEL_INGEST_SECRET_<UPPER_SITE_KEY>   HMAC site secret (REQUIRED)
//   SCRUBBER_JWT_SECRET                    HS256 secret for attestation (if scrubber required)
//   PANEL_OPENCODE_ENABLED=1               force on
//   PANEL_OPENCODE_DISABLED=1              hard kill

import crypto from "node:crypto";

const DEFAULTS = {
  panelUrl: "http://127.0.0.1:3015",
  scrubberUrl: "http://127.0.0.1:3017",
  siteKey: "pk_test_thirdparty",
  sourceAgent: "opencode",
  samplingRate: 0.05,
  samplingRateOverride: false,
  noveltyThreshold: 0.7,
  lruSize: 200,
  maxMessages: 25,
};

const SOFT_SAMPLING_CAP = 0.25;

// ── circuit breaker ───────────────────────────────────────────────────────
function makeBreaker() {
  return {
    failures: [],
    openedAt: 0,
    windowMs: 60_000,
    cooldownMs: 5 * 60_000,
    threshold: 3,
    recordFailure(now) {
      this.failures.push(now);
      const recent = this.failures.filter((t) => now - t < this.windowMs);
      this.failures = recent;
      if (recent.length >= this.threshold) this.openedAt = now;
    },
    isOpen(now) {
      if (!this.openedAt) return false;
      if (now - this.openedAt >= this.cooldownMs) {
        this.openedAt = 0;
        this.failures = [];
        return false;
      }
      return true;
    },
  };
}

// ── novelty (jaccard over token sets, last-N message window) ──────────────
function tokenSet(messages) {
  const tokens = new Set();
  const window = messages.slice(-8);
  for (const m of window) {
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    for (const p of parts) {
      const txt = typeof p?.text === "string" ? p.text : "";
      for (const w of txt.toLowerCase().split(/\s+/)) {
        if (w) tokens.add(w);
      }
    }
    if (typeof m?.content === "string") {
      for (const w of m.content.toLowerCase().split(/\s+/)) if (w) tokens.add(w);
    }
  }
  return tokens;
}

function noveltyScore(tokens, lru) {
  if (!tokens.size || !lru.length) return 1.0;
  let best = 0;
  for (const prev of lru) {
    if (!prev?.size) continue;
    let inter = 0;
    for (const t of tokens) if (prev.has(t)) inter += 1;
    const union = tokens.size + prev.size - inter;
    if (union === 0) continue;
    const j = inter / union;
    if (j > best) best = j;
  }
  return 1.0 - best;
}

// ── error detection ───────────────────────────────────────────────────────
function hasError(messages) {
  for (const m of messages) {
    if (m?.error) return true;
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    for (const p of parts) {
      if (p?.state?.status === "error") return true;
      if (p?.type === "tool" && p?.state?.error) return true;
    }
  }
  return false;
}

// ── decision ──────────────────────────────────────────────────────────────
export function decideForward({ messages, cfg, lru, force = false, rng = Math.random }) {
  if (force) return { forward: true, reason: "force" };
  if (hasError(messages)) return { forward: true, reason: "error_flag" };
  const tokens = tokenSet(messages);
  const novelty = noveltyScore(tokens, lru);
  if (novelty >= cfg.noveltyThreshold) {
    return { forward: true, reason: "novelty", tokens, novelty };
  }
  if (rng() < cfg.samplingRate) {
    return { forward: true, reason: "sample", tokens, novelty };
  }
  return { forward: false, reason: "baseline", tokens, novelty };
}

// ── opencode → splitter shape normalization ──────────────────────────────
// panel's splitter expects {role, content: string, tool_calls?}. opencode
// messages carry {role, parts: [{type, text|state}]}. We flatten parts
// into a single content string while preserving tool-call presence as a
// hinted structured tool_calls entry so the splitter can emit step_validity
// candidates against tool steps.
function normalizeForPanel(messages) {
  return messages.map((m, idx) => {
    const role = String(m?.role ?? "assistant");
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    const textChunks = [];
    const toolCalls = [];
    for (const p of parts) {
      if (typeof p?.text === "string" && p.text) textChunks.push(p.text);
      if (p?.type === "tool") {
        toolCalls.push({
          name: p?.tool ?? p?.state?.tool ?? "unknown",
          status: p?.state?.status ?? "completed",
          error: p?.state?.error ?? null,
          input: p?.state?.input ?? null,
          output: p?.state?.output ?? null,
        });
      }
    }
    let content = textChunks.join("\n\n").trim();
    if (!content && typeof m?.content === "string") content = m.content;
    const out = { role, content };
    if (toolCalls.length) out.tool_calls = toolCalls;
    if (m?.id) out.id = m.id;
    if (m?.sessionID) out.session_id = m.sessionID;
    out.idx = idx;
    return out;
  });
}

// The scrubber service is text-in / text-out — it returns no attestation.
// The plugin self-signs an HS256 attestation JWT below (the scrubber + panel
// share SCRUBBER_JWT_SECRET out-of-band; panel verifies the JWT covers the
// final outbound body hash).
async function scrubText(scrubberUrl, text) {
  if (!scrubberUrl) return text;
  const res = await fetch(`${scrubberUrl.replace(/\/$/, "")}/v1/scrub`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, mode: "text" }),
  });
  if (!res.ok) throw new Error(`scrubber_${res.status}`);
  const json = await res.json();
  return typeof json?.text === "string" ? json.text : text;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signHs256(secret, payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const si = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(si).digest();
  return `${si}.${b64url(sig)}`;
}

async function scrubMessages(scrubberUrl, messages) {
  if (!scrubberUrl) return messages;
  const out = [];
  for (const m of messages) {
    const next = { ...m };
    if (typeof m?.content === "string" && m.content) {
      next.content = await scrubText(scrubberUrl, m.content);
    }
    if (Array.isArray(m?.tool_calls)) {
      next.tool_calls = await Promise.all(
        m.tool_calls.map(async (tc) => {
          const t = { ...tc };
          if (typeof tc?.input === "string" && tc.input) t.input = await scrubText(scrubberUrl, tc.input);
          if (typeof tc?.output === "string" && tc.output) t.output = await scrubText(scrubberUrl, tc.output);
          return t;
        })
      );
    }
    out.push(next);
  }
  return out;
}

// ── panel ingest ──────────────────────────────────────────────────────────
async function shipToPanel(cfg, payload) {
  // 1. opencode shape → splitter shape
  const normalized = normalizeForPanel(payload.blob.messages);
  // 2. per-message scrub (text-only; preserves shape)
  const scrubbed = {
    ...payload,
    blob: { ...payload.blob, messages: await scrubMessages(cfg.scrubberUrl, normalized) },
  };
  // 2. canonical JSON body
  const body = JSON.stringify(scrubbed);

  // 3. site HMAC over body
  const upper = cfg.siteKey.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const ingestSecret =
    process.env[`PANEL_INGEST_SECRET_${upper}`] || process.env.PANEL_INGEST_SECRET || "";
  if (!ingestSecret) throw new Error("ingest_secret_missing");
  const sig = crypto.createHmac("sha256", ingestSecret).update(body).digest("hex");

  // 4. attestation JWT (self-signed; covers output_hash = sha256(body))
  const headers = {
    "content-type": "application/json",
    "x-panel-site-key": cfg.siteKey,
    "x-panel-ingest-sig": sig,
  };
  const scrubberSecret = process.env.SCRUBBER_JWT_SECRET || "";
  if (cfg.scrubberUrl && scrubberSecret) {
    const now = Math.floor(Date.now() / 1000);
    const token = signHs256(scrubberSecret, {
      jti: crypto.randomBytes(16).toString("hex"),
      iat: now,
      exp: now + 300,
      input_hash: "x",
      output_hash: crypto.createHash("sha256").update(body).digest("hex"),
      mode: "text",
      engine_version: "0.2.0",
    });
    headers["x-scrubber-attestation"] = token;
  }

  const res = await fetch(`${cfg.panelUrl.replace(/\/$/, "")}/api/v1/traces`, {
    method: "POST",
    headers,
    body,
  });
  return { status: res.status, body: await res.text() };
}

// ── config resolution ─────────────────────────────────────────────────────
function resolveCfg(options) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  let rate = Number(cfg.samplingRate);
  if (!Number.isFinite(rate) || rate < 0) rate = 0.05;
  if (rate > SOFT_SAMPLING_CAP && !cfg.samplingRateOverride) {
    rate = SOFT_SAMPLING_CAP;
  }
  cfg.samplingRate = rate;
  return cfg;
}

// ── plugin export ─────────────────────────────────────────────────────────
export const PanelPlugin = async ({ client, project, directory }, options = {}) => {
  if (process.env.PANEL_OPENCODE_DISABLED === "1") {
    return {}; // hard kill
  }
  const cfg = resolveCfg(options);
  const lru = []; // array of Set<string>
  const breaker = makeBreaker();
  const recent = []; // last 10 attempts (debug)
  const inflight = new Set(); // sessionIDs currently being forwarded

  async function handleIdle(sessionID) {
    if (inflight.has(sessionID)) return;
    const now = Date.now();
    if (breaker.isOpen(now)) {
      recent.push({ ts: now, sessionID, status: "circuit_open" });
      return;
    }
    inflight.add(sessionID);
    try {
      // fetch full message list for this session
      const resp = await client.session.messages({
        path: { id: sessionID },
        throwOnError: false,
      });
      const data = resp?.data ?? resp;
      const messages = Array.isArray(data) ? data : data?.messages ?? [];
      if (!messages.length) {
        recent.push({ ts: now, sessionID, status: "skipped", reason: "no_messages" });
        return;
      }
      const trimmed = messages.slice(-cfg.maxMessages);
      const decision = decideForward({ messages: trimmed, cfg, lru });
      if (!decision.forward) {
        recent.push({ ts: now, sessionID, status: "skipped", reason: decision.reason });
        return;
      }
      const payload = {
        trace_id: `tr_oc_${sessionID.slice(0, 8)}_${now.toString(36)}`,
        source_agent: cfg.sourceAgent,
        blob: {
          session_id: sessionID,
          project_id: project?.id ?? null,
          directory,
          messages: trimmed,
          reason: decision.reason,
          plugin_version: "0.1.0",
        },
      };
      const result = await shipToPanel(cfg, payload);
      if (result.status >= 200 && result.status < 300) {
        if (decision.tokens) {
          lru.push(decision.tokens);
          while (lru.length > cfg.lruSize) lru.shift();
        }
        recent.push({ ts: now, sessionID, status: "ok", http: result.status, reason: decision.reason });
      } else {
        breaker.recordFailure(now);
        recent.push({ ts: now, sessionID, status: "error", http: result.status, body: result.body.slice(0, 200) });
      }
    } catch (err) {
      breaker.recordFailure(Date.now());
      recent.push({ ts: Date.now(), sessionID, status: "error", detail: String(err?.message || err) });
    } finally {
      inflight.delete(sessionID);
      while (recent.length > 10) recent.shift();
    }
  }

  return {
    event: async ({ event }) => {
      if (event?.type !== "session.idle") return;
      const sessionID = event?.properties?.sessionID;
      if (!sessionID) return;
      // intentionally NOT awaited — fire and forget
      handleIdle(sessionID).catch((e) => {
        // last-resort guard; should never reach here
        console.error("[panel-opencode-plugin] swallowed:", e?.message || e);
      });
    },
  };
};

export default { server: PanelPlugin };

// WS-V3: V1 unit-type emit helpers (skill_diff, process_output, prompt_rewrite).
export { emitSkillDiff, emitProcessOutput, emitPromptRewrite } from './emit-units.js';
