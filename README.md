# freebuff-9router-provider

**Use Freebuff's free models (GLM 5.3 Flash, DeepSeek V4.1 Flash, MiMo 2.6 Flash, …) as a provider inside [9router](https://github.com/decolua/9router)** — or any tool that speaks the OpenAI API (Claude Code via 9router, OpenCode, Hermes Agent, curl, …).

This is **not another router**. It is a tiny local sidecar (zero dependencies, Node ≥ 18) that:

1. logs you in **once** with Freebuff's **official browser login flow** (the same one the Freebuff CLI uses),
2. exposes an **OpenAI-compatible endpoint** at `http://127.0.0.1:8787/v1`,
3. manages the free-seat session (admission, keepalive, release) exactly like the official client, and
4. translates `POST /v1/chat/completions` to Freebuff's `/api/v1/chat/completions` wire format.

You then add `http://127.0.0.1:8787/v1` in **9router → Add Provider → OpenAI Compatible** and every Freebuff model shows up next to your other providers.

> راهنمای فارسی: [README.fa.md](./README.fa.md)

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Login](#login)
- [Run the provider](#run-the-provider)
- [Add it to 9router](#add-it-to-9router)
- [Models](#models)
- [API](#api)
- [Tests](#tests)
- [Honest client — what this tool does NOT do](#honest-client--what-this-tool-does-not-do)
- [Limits & troubleshooting](#limits--troubleshooting)
- [Docs](#docs)
- [License](#license)

---

## How it works

```
Claude Code / OpenCode / Hermes / anything
            │  (Anthropic / OpenAI)
            ▼
        9router  (your existing router)
            │  (OpenAI-compatible)
            ▼
freebuff-9router-provider  (this tool, localhost:8787)
            │  official login + free-seat session + CLI wire format
            ▼
     freebuff.com / codebuff.com
   GLM 5.3 Flash · DeepSeek V4.1 Flash · MiMo 2.6 Flash · …
```

The sidecar performs, per chat request, the same sequence the official Freebuff CLI performs:

| Step | Wire call |
|------|-----------|
| Login (once) | `POST https://freebuff.com/api/auth/cli/code` → open `loginUrl` in browser → poll `GET /api/auth/cli/status` |
| Who you are | `GET https://codebuff.com/api/v1/me?fields=id,email` |
| Free seat | `POST /api/v1/freebuff/session/admission` → keepalive `GET /api/v1/freebuff/session` (≈30 s) → `DELETE` on stop |
| Agent run | `POST /api/v1/agent-runs` `{action:"START", agentId:"base3-free-…"}` |
| Chat | `POST /api/v1/chat/completions` (OpenAI-shaped body, SSE back) |
| Finish | `POST /api/v1/agent-runs` `{action:"FINISH", …}` with an honest step report |

The full protocol is documented in [docs/PROTOCOL.md](./docs/PROTOCOL.md).

---

## Requirements

- **Node.js ≥ 18.17** (no `npm install` — zero dependencies)
- A **free Freebuff account** — create one by logging in at <https://freebuff.com> during `fb9r login`
- [9router](https://github.com/decolua/9router) already installed (or any OpenAI-speaking tool)

## Install

```bash
git clone https://github.com/Godde3s/freebuff-9router-provider.git
cd freebuff-9router-provider
node bin/fb9r.js help        # everything runs from source
```

Optional global command:

```bash
npm link                     # makes `fb9r` available everywhere
```

## Login

```bash
fb9r login
```

- A URL is printed and your browser opens it.
- Approve the login on freebuff.com (log in / create an account there).
- The provider polls and stores your credentials in `~/.config/freebuff-9router/credentials.json` (mode `0600`).

Already logged in with the official Freebuff CLI? Skip the browser step:

```bash
fb9r import                  # copies the token from ~/.config/manicode/credentials.json (read-only)
```

## Run the provider

```bash
fb9r serve                   # http://127.0.0.1:8787
# options
fb9r serve --port 9000       # custom port
fb9r serve --api-key mylocal # require that key on chat calls (recommended if not on localhost-only)
```

Keep the terminal open (or run it under systemd / pm2 / a tmux pane). `Ctrl+C` **releases your free seat** before exiting — this matters, see [Limits](#limits--troubleshooting).

## Add it to 9router

Detailed, screenshot-level steps: [docs/CONNECT-9ROUTER.md](./docs/CONNECT-9ROUTER.md)

Short version — in the 9router dashboard:

1. **Providers → Add Provider → OpenAI Compatible**
2. Fill in:
   - **Name / ID**: `freebuff`
   - **Base URL**: `http://127.0.0.1:8787/v1`
   - **API key**: anything (e.g. `fb9r-local`) — or the value of your `--api-key`
3. Add the models (see below), save, and test a model from the provider page.
4. Point Claude Code / OpenCode / Hermes at 9router as usual and pick e.g. `z-ai/glm-5.3-flash`.

## Models

| Upstream id | Aliases | Access |
|---|---|---|
| `z-ai/glm-5.3-flash` | `glm-5.3-flash`, `glm` | **unmetered** at full access — default |
| `deepseek/deepseek-v4-flash` | `deepseek-v4.1-flash`, `deepseek` | **unmetered** at full access |
| `mimo/mimo-v2.5` | `mimo-2.6-flash`, `mimo` | **unmetered** at full access |
| `upstage/solar-mini4` | `solar-mini-4`, `solar` | **unmetered**, 524K ctx, text only |
| `minimax/minimax-m3` | `minimax-m3`, `minimax` | capacity-dependent |
| `openai/gpt-6-luna` | `gpt-6-luna`, `luna` | US / paid plans |
| `stealth/space-bunny-alpha` | `space-bunny-alpha` | beta, retains prompts |
| `google/gemini-3.8-flash` | `gemini-3.8-flash` | paid plans |

`fb9r models` prints this table anytime. Aliases are case-insensitive and resolved server-side by the provider.

`reasoning_effort` is supported and clamped to GLM's ladder (`low|high|max`).

## API

Once the sidecar is running:

| Route | Description |
|---|---|
| `GET /v1/models` | OpenAI model list (includes aliases) |
| `POST /v1/chat/completions` | OpenAI chat completions, `stream: true/false` |
| `GET /health` | login state, session state, account |
| `DELETE /v1/session` | release the free seat manually |

Example:

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm","stream":false,"messages":[{"role":"user","content":"Salam! Code yek Fibonacci be Go."}]}'
```

## Tests

```bash
npm test        # 24 tests, mock upstream — no account needed
```

Covers: the canonical-opening envelope, login code/poll flow (incl. pending-401), credential file mode (`0600`) and CLI import, seat admission/refresh/release, model switching, error taxonomy mapping (429 → `rate_limited` + `retryAfterMs`), SSE passthrough, non-stream aggregation, and the local API-key gate.

## Honest client — what this tool does NOT do

Freebuff's free tier is funded by ads shown in Freebuff's own apps, and its servers run checks against abusive third-party callers. This provider deliberately stays on the honest side of that line:

- **One account, one seat.** No pools, no token rotation, no multi-accounting.
- **Official login only.** The browser code-in-URL flow, nothing else.
- **Your prompts are never rewritten.** Upstream's free mode requires the first system message to open with Freebuff's canonical client identity (`You are Buffy, …`). This provider *prepends* that opening and passes your content through **verbatim**. It does **not** strip, replace or mask "foreign harness" markers (Claude Code, Hermes, Aider, …) the way some proxy projects do — that is detection evasion, and if upstream rejects such a prompt you will see the exact upstream error, not a disguised one.
- **No fingerprint/TLS games.** A random stable id for login, the CLI's normal request shapes, no stealth modules, no proxy-shaped ids.
- **No fake ad events.** The bridge renders no ads and fakes no impressions.
- **Limits are respected**, not bypassed: rate limits, spend ceilings, country gates and bans are surfaced verbatim with their real `Retry-After`.

See [docs/POLICY.md](./docs/POLICY.md) for the reasoning and the upstream context.

## Limits & troubleshooting

| Symptom | Meaning | What to do |
|---|---|---|
| `429 rate_limited` | real upstream rate limit for your account | wait for `retryAfterMs`, it resets on its own |
| `429 spend_limited` | daily cap reached | resets at midnight Pacific (per upstream) |
| `403 country_blocked` / `free_mode_unavailable` | region/VPN gate | free mode from supported regions; the provider does not fake location |
| `session_superseded` (409) | another client took the account's single seat | close the other Freebuff CLI/Desktop, retry |
| foreign system-prompt rejection | your tool's system prompt is flagged upstream | this is Freebuff's gate — use tools whose prompts pass, or the official CLI; this provider will not disguise prompts |
| `401` from provider | not logged in | `fb9r login` or `fb9r import` |

Session seats expire on their own after ~1 hour upstream; the sidecar keepalives while running and releases the seat on `Ctrl+C` / `SIGTERM` / `DELETE /v1/session`.

## Docs

- [docs/CONNECT-9ROUTER.md](./docs/CONNECT-9ROUTER.md) — exact 9router setup, both UI and manual JSON
- [docs/PROTOCOL.md](./docs/PROTOCOL.md) — the full upstream wire protocol this implements
- [docs/POLICY.md](./docs/POLICY.md) — honest-client rules, upstream gates, and why evasion was left out
- [README.fa.md](./README.fa.md) — راهنمای کامل فارسی

## License

MIT — see [LICENSE](./LICENSE).
