# panel-opencode-plugin

Forward a sampled subset of [opencode](https://opencode.ai) session traces to a [panel](https://panel.goku.codes) ingest endpoint so that rater pools can judge real agent output (skill diffs, step validity, hallucinations, pairwise comparisons).

Companion to the hermes-side [`panel_trace_forwarder`](https://github.com/UltraInstinct0x/panel-sdk-node). Same contract, same sampling defaults, same circuit-breaker shape.

## Install

```bash
opencode plugin install @ultrainstinct/panel-opencode-plugin
# or locally during dev:
cd ~/.opencode && bun add file:/path/to/panel-opencode-plugin
```

Then in `~/.opencode/opencode.json`:

```jsonc
{
  "plugin": [
    ["@ultrainstinct/panel-opencode-plugin", {
      "panelUrl": "https://panel.goku.codes",
      "scrubberUrl": "https://scrubber.goku.codes",
      "siteKey": "pk_live_yourkey",
      "sourceAgent": "opencode",
      "samplingRate": 0.05
    }]
  ]
}
```

Provide the ingest secret in the env that runs opencode:

```bash
export PANEL_INGEST_SECRET_PK_LIVE_YOURKEY=...  # HMAC site secret
export SCRUBBER_JWT_SECRET=...                  # if scrubber required for this site
```

## Sampling policy (D17)

A session is forwarded when **any** of:

- baseline random sample (default 5%, soft-capped at 25% unless `samplingRateOverride: true`)
- session contains a tool/agent error
- session content is *novel*: jaccard over the last 8 messages' token sets is < 0.3 vs the LRU of the last 200 shipped sessions

Decision happens on the `session.idle` event. The request is fire-and-forget — the agent loop is **never blocked**.

## Circuit breaker

3 non-2xx panel responses within 60s open the breaker for 5 minutes. While open, the plugin records `circuit_open` in its in-memory ring and ships nothing.

## Privacy

If `scrubberUrl` is set (default `http://127.0.0.1:3017`), every blob is POSTed to `/scrub` first and the sanitized version + attestation JWT is what reaches panel. Set `scrubberUrl: ""` to bypass (dev only).

## Config reference

| key | default | meaning |
|-----|---------|---------|
| `panelUrl` | `http://127.0.0.1:3015` | panel base URL |
| `scrubberUrl` | `http://127.0.0.1:3017` | scrubber base URL (empty disables) |
| `siteKey` | `pk_test_thirdparty` | panel site key |
| `sourceAgent` | `opencode` | written into the trace |
| `samplingRate` | `0.05` | 0–0.25 (raise cap with override) |
| `samplingRateOverride` | `false` | unlock rates above the 0.25 soft cap |
| `noveltyThreshold` | `0.7` | `1 - jaccard_max` cutoff |
| `lruSize` | `200` | LRU of previously-shipped token sets |
| `maxMessages` | `25` | tail of session messages included in blob |

## Env

| var | meaning |
|-----|---------|
| `PANEL_INGEST_SECRET_<UPPER_SITE_KEY>` | HMAC site secret (required) |
| `SCRUBBER_JWT_SECRET` | HS256 secret if scrubber gates with attestation |
| `PANEL_OPENCODE_ENABLED=1` | force-on |
| `PANEL_OPENCODE_DISABLED=1` | hard kill (plugin returns no hooks) |

## Testing

```bash
cd panel-opencode-plugin
node --test test/*.test.js
```

Includes a stub panel server + stub opencode client for end-to-end integration coverage without touching the network or a real opencode install.

## License

MIT — UltraInstinct0x
