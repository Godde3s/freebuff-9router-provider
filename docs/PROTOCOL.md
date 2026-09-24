# Upstream wire protocol reference

What this provider implements, endpoint by endpoint. Derived from the
official Freebuff CLI (npm `freebuff`) wire behavior and the public
`CodebuffAI/freebuff` monorepo. This is documentation of *what the official
client does* — nothing here is invented or evasion-specific.

## Origins

| Purpose | Origin |
|---|---|
| Login (code + status + logout) | `https://freebuff.com` |
| API (me, session, agent-runs, chat) | `https://codebuff.com` |

## 1. Login (once; no refresh tokens exist upstream)

```
POST /api/auth/cli/code            { fingerprintId }
  -> 200 { loginUrl, fingerprintHash, expiresAt }      // code lifetime: 60 min
GET  /api/auth/cli/status?fingerprintId=&fingerprintHash=&expiresAt=
  -> 401  still pending (poll every 5 s, give up after 5 min)
  -> 200 { user: { id, name, email, authToken, ... } }
```

- `fingerprintId` is a stable per-install id. The official CLI derives it
  from hardware details; this provider uses a random `fb9r-<32 hex>` stored
  in credentials — honest and stable, nothing hardware-derived.
- There is **no refresh-token mechanism**. When the token stops working,
  run `fb9r login` again.

## 2. Token probe

```
GET /api/v1/me?fields=id,email     Authorization: Bearer <token>
  -> 200 { id, email }
```

Used to show the connected account and to source the account's **own** id
for `x-freebuff-acting-user-id` on chat (the header the CLI sends; the
server only honors it for the Freebuff Web service account, so the only
honest value is our own id).

## 3. Free-seat session

The free tier admits **one seat per account**. Model is immutable
mid-session; seats expire after ~1 h.

| Call | When | Headers (besides auth) |
|---|---|---|
| `POST /api/v1/freebuff/session/admission` | acquire | `x-freebuff-model`, `x-freebuff-wallet-spend-limit: 0`, `x-fb-timezone`, `x-freebuff-first-tab-discount: 0` |
| `GET /api/v1/freebuff/session` | keepalive ≈30 s ±20% | `x-freebuff-instance-id` |
| `DELETE /api/v1/freebuff/session` | release | `x-freebuff-instance-id` |

Admission responses this provider maps: `active` (+`instanceId`), and the
typed states `model_locked`, `model_unavailable`, `consent_required`,
`rate_limited`, `spend_limited`, `ip_capped`, `country_blocked`, `banned` —
each surfaced verbatim with its `retryAfterMs` when present.

Upstream can deliver these refusals two ways: as a real 4xx status, or as
HTTP 200 with a non-`active` `status` body. The provider maps both to the
HTTP status they semantically are (so 9router's backoff logic works), while
keeping the original code and `retryAfterMs` in the error body:

| Upstream state | HTTP to the local caller |
|---|---|
| `rate_limited`, `spend_limited`, `ip_capped` | **429** (+ `retryAfterMs`) |
| `country_blocked`, `banned`, `consent_required`, `free_mode_unavailable` | **403** |
| `model_locked`, `superseded`, `session_superseded` | **409** |
| `model_unavailable` | **503** |
| anything else non-`active` | 502 |

A chat call rejected with `superseded` (the seat was taken by another
client on the same account — upstream also signals it with 409) resets the
local seat so the next request re-admits automatically.

A stalled upstream never hangs the caller: non-stream JSON calls have a
countdown covering headers **and** body (typed `504 upstream_timeout`), and
chat has a time-to-first-byte deadline that stops once the SSE stream is
flowing.

## 4. Agent runs

```
POST /api/v1/agent-runs   { action: "START",  agentId: "base3-free-…", ancestorRunIds: [] }
  -> 200 { runId }
POST /api/v1/agent-runs   { action: "FINISH", runId, status, totalSteps,
                            directCredits: 0, totalCredits: 0, steps: [...] }
```

Auth carries both `Authorization: Bearer <token>` and
`x-codebuff-api-key: <token>` (the dual-auth the agent-runtime client sends).

## 5. Chat

```
POST /api/v1/chat/completions
  Authorization: Bearer <token>
  x-freebuff-acting-user-id: <own account id>
  User-Agent: ai-sdk/openai-compatible/1.0.0/codebuff
  Accept: application/json, text/event-stream

  {
    "model": "z-ai/glm-5.3-flash",
    "messages": [ ... ],                 // first system message opens with the
                                         // canonical client opening
    "stream": true,
    "reasoning_effort": "max",           // GLM ladder: low | high | max
    "codebuff_metadata": {
      "run_id":  "<uuid>",               // same run as START/FINISH
      "client_id": "<13 base36 chars>",  // CLI shape, one per run
      "freebuff_instance_id": "<seat>",
      "llm_step_number": "1",
      "cost_mode": "free",
      "freebuff_reasoning_effort": "max"
    },
    "provider": { "data_collection": "deny" }
  }

  <- 200 text/event-stream   (OpenAI-style chunks, terminated by `data: [DONE]`)
```

Upstream always streams; the provider aggregates server-side when the local
caller asked for `stream: false`. If the upstream stream dies mid-flight,
the local stream closes with one OpenAI-shaped SSE error frame followed by
`data: [DONE]` — streaming clients always learn why the stream ended.

The full quota/limit taxonomy behind these states is documented in
[LIMITS.md](./LIMITS.md).

## 6. Free-mode gates (server-side)

Requests must satisfy, or they are rejected with a typed 4xx:

- `codebuff_metadata.cost_mode = "free"` (else `free_mode_cost_mode_required`)
- agent + model pair on the free allowlist — e.g.
  `base3-free-glm-5-3-flash` ↔ `z-ai/glm-5.3-flash`
  (else `free_mode_invalid_agent_model`)
- first system message opening with a canonical Freebuff client identity
- no recognizable "foreign harness" markers in system prompts
  (`foreign_system_prompt`) — this provider passes prompts through untouched
  and shows you the upstream error if it fires; it does not scrub markers
- client-id shapes that do not fingerprint as a proxy
  (`looksLikeProxyClientId`) — plain CLI-shaped random ids only

## 7. Agent ↔ model map (free roots used by this provider)

| Model id (= wire id, also this provider's label) | Root agent |
|---|---|
| `z-ai/glm-5.3-flash` (GLM 5.3 Flash) | `base3-free-glm-5-3-flash` |
| `deepseek/deepseek-v4-flash` (DeepSeek V4 Flash) | `base3-free-deepseek-flash` |
| `mimo/mimo-v2.5` (MiMo 2.5) | `base3-free-mimo` |
| `upstage/solar-mini4` (Solar Mini 4) | `base3-free-solar-mini4` |
| `minimax/minimax-m3` (MiniMax M3) | `base3-free-minimax-m3` |
| `openai/gpt-6-luna` (GPT-6 Luna) | `base3-free-luna-6` |
| `stealth/space-bunny-alpha` (Space Bunny Alpha) | `base3-free-space-bunny-alpha` |
| `google/gemini-3.8-flash` (Gemini 3.8 Flash) | `base3-free-gemini-3-8-flash` |

> The DeepSeek and MiMo ids are upstream's undated legacy slugs, kept stable
> by Freebuff across model updates so saved picks and allowlists survive.
> This provider labels each row exactly by its wire id, so the model name
> you configure is precisely what the wire sends. The sourced history of
> upstream's picker displayNames for these rows lives in LIMITS.md.

## 8. Logout

```
POST /api/auth/cli/logout   { userId, fingerprintId, fingerprintHash }
```

Best effort — local credentials are cleared regardless, like the CLI does.
