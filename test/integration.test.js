// Integration test: spins up a stub panel ingest server and a stub opencode
// client object, then invokes the plugin's exposed event hook to verify the
// full sample → ship path works end-to-end without network or real opencode.
//
// Run: node --test test/integration.test.js

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { PanelPlugin } from "../src/index.js";

function startStubPanel() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ trace_id: "tr_stub_xxx", unit_ids: [], structural_count: 0, llm_count: 0, skipped_count: 0 }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise((r) => server.close(() => r())),
        received,
      });
    });
  });
}

function makeStubClient(messages) {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  };
}

test("happy path: novel content → forwarded with hmac sig", async () => {
  process.env.PANEL_INGEST_SECRET_PK_TEST_INTEG = "shhh";
  const panel = await startStubPanel();
  try {
    const hooks = await PanelPlugin(
      {
        client: makeStubClient([
          { role: "user", parts: [{ type: "text", text: "this is a brand new question never seen before" }] },
          { role: "assistant", parts: [{ type: "text", text: "novel answer here" }] },
        ]),
        project: { id: "proj_test" },
        directory: "/tmp/test",
      },
      {
        panelUrl: panel.url,
        scrubberUrl: "", // bypass scrubber for the integration test
        siteKey: "pk_test_integ",
        samplingRate: 0,           // force "novelty" reason
        noveltyThreshold: 0.5,
      }
    );

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_abc12345" } } });

    // give the fire-and-forget some time
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(panel.received.length, 1);
    const req = panel.received[0];
    assert.equal(req.url, "/api/v1/traces");
    assert.equal(req.headers["x-panel-site-key"], "pk_test_integ");

    // verify HMAC
    const expected = crypto
      .createHmac("sha256", "shhh")
      .update(req.body)
      .digest("hex");
    assert.equal(req.headers["x-panel-ingest-sig"], expected);

    const body = JSON.parse(req.body);
    assert.equal(body.source_agent, "opencode");
    assert.equal(body.blob.session_id, "ses_abc12345");
    assert.equal(body.blob.reason, "novelty");
    assert.ok(Array.isArray(body.blob.messages));
  } finally {
    await panel.stop();
    delete process.env.PANEL_INGEST_SECRET_PK_TEST_INTEG;
  }
});

test("ignored event types: file.edited → no ship", async () => {
  process.env.PANEL_INGEST_SECRET_PK_TEST_INTEG2 = "shhh";
  const panel = await startStubPanel();
  try {
    const hooks = await PanelPlugin(
      { client: makeStubClient([]), project: { id: "p" }, directory: "/tmp" },
      { panelUrl: panel.url, scrubberUrl: "", siteKey: "pk_test_integ2", samplingRate: 1.0, samplingRateOverride: true }
    );
    await hooks.event({ event: { type: "file.edited", properties: { file: "x.ts" } } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(panel.received.length, 0);
  } finally {
    await panel.stop();
    delete process.env.PANEL_INGEST_SECRET_PK_TEST_INTEG2;
  }
});

test("disable kill-switch: PANEL_OPENCODE_DISABLED=1 returns empty hooks", async () => {
  process.env.PANEL_OPENCODE_DISABLED = "1";
  try {
    const hooks = await PanelPlugin(
      { client: makeStubClient([]), project: { id: "p" }, directory: "/tmp" },
      { siteKey: "pk_test_x" }
    );
    assert.deepEqual(hooks, {});
  } finally {
    delete process.env.PANEL_OPENCODE_DISABLED;
  }
});
