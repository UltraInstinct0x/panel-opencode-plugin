# panel-opencode-plugin

Forward sampled [opencode](https://opencode.ai) session traces to panel `POST /api/v1/traces` for downstream rater-unit generation.

## Install

```bash
opencode plugin install @ultrainstinct/panel-opencode-plugin
```

## opencode.json example

```json
{
  "plugin": [
    [
      "@ultrainstinct/panel-opencode-plugin",
      {
        "panelUrl": "https://panel.goku.codes",
        "scrubberUrl": "https://scrubber.goku.codes",
        "siteKey": "pk_live_example",
        "sourceAgent": "opencode",
        "samplingRate": 0.05,
        "samplingRateOverride": false,
        "noveltyThreshold": 0.7,
        "lruSize": 200,
        "maxMessages": 25,
        "dryRun": false
      }
    ]
  ]
}
```

## Config + env reference

| Option | Default | Env override | Description |
|---|---:|---|---|
| `panelUrl` | `http://127.0.0.1:3015` | — | Panel base URL |
| `scrubberUrl` | `http://127.0.0.1:3017` | — | Scrubber base URL (`""` disables scrubber) |
| `siteKey` | `pk_test_thirdparty` | — | Sent as `X-Panel-Site-Key` |
| `sourceAgent` | `opencode` | — | `source_agent` field in trace payload |
| `samplingRate` | `0.05` | — | Baseline random forwarding rate |
| `samplingRateOverride` | `false` | — | Allows rates above 0.25 cap |
| `noveltyThreshold` | `0.7` | — | Forward when novelty score is `>=` threshold |
| `lruSize` | `200` | — | Token-set history size for novelty checks |
| `maxMessages` | `25` | — | Tail messages included in trace blob |
| `dryRun` | `false` | — | Log/decide but do not POST to panel |

| Environment variable | Required | Purpose |
|---|---|---|
| `PANEL_INGEST_SECRET_<UPPER_SITE_KEY>` | Yes (or fallback below) | Site-specific HMAC secret |
| `PANEL_INGEST_SECRET` | Fallback | Global HMAC secret fallback |
| `SCRUBBER_JWT_SECRET` | If scrubber-attestation required | HS256 secret for self-signed `X-Scrubber-Attestation` |
| `PANEL_OPENCODE_DISABLED=1` | Optional | Hard-disable plugin (returns no hooks) |
| `PANEL_OPENCODE_ENABLED=1` | Optional | Force-on toggle for ops compatibility |

## Behavior summary

- Trigger: `session.idle`
- Forward when any of:
  - novelty score `>= noveltyThreshold`
  - error in message/tool state
  - baseline sampling hit
- Scrubber flow: plugin calls `POST /v1/scrub` and uses response `{ scrubbed, mapping_id?, ... }`
- Ingest auth headers:
  - `X-Panel-Site-Key`
  - `X-Panel-Ingest-Sig` (`hex(HMAC_SHA256(secret, raw_body_bytes))`)
  - `X-Scrubber-Attestation` (HS256 JWT) when scrubber secret available
- Fire-and-forget send to `POST /api/v1/traces`
- Treats `202 Accepted` as success (async trace splitting path)

## Troubleshooting

### Circuit breaker open

If panel returns 3 non-2xx responses within 60s, breaker opens for 5 minutes and forwarding pauses.

### 401 / `ingest_secret_missing`

Set `PANEL_INGEST_SECRET_<UPPER_SITE_KEY>` (or `PANEL_INGEST_SECRET`) in the environment where opencode runs.

### 422 `scrubber_attestation_required`

Panel site key is scrubber-gated. Ensure `SCRUBBER_JWT_SECRET` is set and matches panel verification secret.

### 202 async response

Large blobs can return `202` with poll location. This plugin treats that as success and does not trip circuit breaker.

### dryRun mode

Set `dryRun: true` to evaluate decisions and payload intent without network POST.

## Tests

```bash
npm test
```

Coverage includes decision logic, HMAC determinism, JWT shape/signing, circuit breaker behavior, sampling cap behavior, and integration paths (`200`, `202`, scrubber, dry-run).
