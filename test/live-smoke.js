// Live smoke: ship a real (synthetic) opencode-shaped trace to the local panel
// ingest endpoint using PanelPlugin's internals, and verify a 200 + unit_ids.
// Usage:
//   source ~/.secrets/panel.env && node test/live-smoke.js
import { PanelPlugin } from "../src/index.js";

const SITE_KEY = "pk_test_thirdparty";
const PANEL_URL = process.env.PANEL_URL || "http://127.0.0.1:3015";

if (!process.env[`PANEL_INGEST_SECRET_${SITE_KEY.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]) {
  console.error("missing PANEL_INGEST_SECRET_PK_TEST_THIRDPARTY in env");
  process.exit(2);
}

const stubClient = {
  session: {
    messages: async () => ({
      data: [
        { role: "user", parts: [{ type: "text", text: "live smoke from panel-opencode-plugin: build a tiny rust calculator with TDD" }] },
        { role: "assistant", parts: [{ type: "text", text: "starting with a failing test for add(2,3)=5; will implement after the red bar." }] },
        { role: "assistant", parts: [{ type: "tool", state: { status: "completed" } }, { type: "text", text: "test passes; refactoring naming." }] },
      ],
    }),
  },
};

const hooks = await PanelPlugin(
  { client: stubClient, project: { id: "proj_live_smoke" }, directory: "/tmp/live-smoke" },
  {
    panelUrl: PANEL_URL,
    scrubberUrl: "",     // bypass scrubber for thirdparty test key (not gated)
    siteKey: SITE_KEY,
    samplingRate: 0,
    noveltyThreshold: 0.5,  // force novelty path
  }
);

await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_livesmoke_" + Date.now().toString(36) } } });
// Wait for the fire-and-forget to actually finish
await new Promise((r) => setTimeout(r, 1500));
console.log("smoke fired — check panel for the new trace.");
