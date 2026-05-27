import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeBreaker, signHs256, resolveCfg } from "../src/index.js";

function b64uDecode(s) {
  let v = s.replace(/-/g, "+").replace(/_/g, "/");
  while (v.length % 4) v += "=";
  return Buffer.from(v, "base64").toString("utf8");
}

test("HMAC determinism: same bytes and secret yield identical digest", () => {
  const secret = "deterministic-secret";
  const body = JSON.stringify({ a: 1, b: "same" });
  const a = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const b = crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(a, b);
});

test("self-signed JWT structure roundtrip: header.payload.signature", () => {
  const token = signHs256("jwt-secret", {
    jti: "abc123",
    iat: 1700000000,
    exp: 1700000300,
    input_hash: "x",
    output_hash: "y",
    mode: "text",
    engine_version: "0.2.0",
  });

  const parts = token.split(".");
  assert.equal(parts.length, 3);

  const header = JSON.parse(b64uDecode(parts[0]));
  const payload = JSON.parse(b64uDecode(parts[1]));

  assert.equal(header.alg, "HS256");
  assert.equal(header.typ, "JWT");
  assert.equal(payload.jti, "abc123");
  assert.equal(payload.output_hash, "y");
  assert.ok(parts[2].length > 10);
});

test("circuit breaker opens at threshold and closes after cooldown", () => {
  const b = makeBreaker();
  const t0 = 1_000_000;

  b.recordFailure(t0);
  b.recordFailure(t0 + 1);
  assert.equal(b.isOpen(t0 + 2), false);

  b.recordFailure(t0 + 3);
  assert.equal(b.isOpen(t0 + 4), true);

  const afterCooldown = t0 + b.cooldownMs + 10;
  assert.equal(b.isOpen(afterCooldown), false);
});

test("sampling cap applies without override and bypasses with override", () => {
  const capped = resolveCfg({ samplingRate: 0.9, samplingRateOverride: false });
  assert.equal(capped.samplingRate, 0.25);

  const uncapped = resolveCfg({ samplingRate: 0.9, samplingRateOverride: true });
  assert.equal(uncapped.samplingRate, 0.9);
});
