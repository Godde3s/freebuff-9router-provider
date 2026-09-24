# Connecting the provider to 9router

Two ways: the dashboard UI (recommended) or the manual JSON config. Both end
with Freebuff models selectable from every CLI 9router supports (Claude Code,
OpenCode, Cline, Codex, Hermes, …).

Prerequisites:

```bash
fb9r serve            # keep this running; default http://127.0.0.1:8787
curl -s http://127.0.0.1:8787/health | jq
# {"ok":true,"loggedIn":true,"email":"you@x.y","session":{"status":"none"},"models":8,...}
```

---

## Way 1 — Dashboard UI

1. Open the 9router dashboard (`http://localhost:20128` by default).
2. Go to **Providers → Add Provider**.
3. Pick **OpenAI Compatible** as the provider type.
4. Fill the form:

   | Field | Value |
   |---|---|
   | Name / ID | `freebuff` |
   | Base URL | `http://127.0.0.1:8787/v1` |
   | API key | `fb9r-local` (any string; or your `--api-key` value) |

5. In the models section add these IDs:

   ```
   z-ai/glm-5.3-flash
   deepseek/deepseek-v4-flash
   mimo/mimo-v2.5
   upstage/solar-mini4
   minimax/minimax-m3
   openai/gpt-6-luna
   ```

6. Save. Back on the provider page, click **Test** next to
   `z-ai/glm-5.3-flash` — you should get a completion in a few seconds.

## Way 2 — Manual config

If you edit 9router's config/DB directly, the connection is an ordinary
OpenAI-compatible custom provider (`openai-compatible-` prefixed id):

```json
{
  "provider": "openai-compatible-freebuff",
  "authType": "apikey",
  "baseUrl": "http://127.0.0.1:8787/v1",
  "apiKey": "fb9r-local",
  "models": [
    "z-ai/glm-5.3-flash",
    "deepseek/deepseek-v4-flash",
    "mimo/mimo-v2.5",
    "upstage/solar-mini4",
    "minimax/minimax-m3"
  ]
}
```

> The UI flow is the supported path; field names in the stored config can
> shift between 9router versions, so prefer **Way 1** unless you know what
> you are doing.

## Point your CLI at 9router (as usual)

Nothing changes here — 9router already exposes the Anthropic and OpenAI
endpoints your tools expect, and it translates to this provider internally:

- **Claude Code** → `ANTHROPIC_BASE_URL=http://localhost:20128` (9router endpoint page)
- **OpenCode / Cline / others** → pick the freebuff models from the model picker

## Sanity checks

```bash
# provider directly
curl -s http://127.0.0.1:8787/v1/models | jq '.data[].id'

# through 9router's OpenAI endpoint (adjust port/key to your setup)
curl -s http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer <your-9router-key>" \
  -H 'Content-Type: application/json' \
  -d '{"model":"z-ai/glm-5.3-flash","messages":[{"role":"user","content":"ping"}]}'
```

## Running it in the background

systemd user unit example (`~/.config/systemd/user/fb9r.service`):

```ini
[Unit]
Description=Freebuff provider for 9router

[Service]
ExecStart=%h/.npm-global/bin/fb9r serve --api-key fb9r-local
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now fb9r
```

pm2: `pm2 start "fb9r serve" --name fb9r` · tmux: `tmux new -d -s fb9r 'fb9r serve'`

> **Important:** stop it with `Ctrl+C` / `SIGTERM` / `systemctl --user stop fb9r`
> (never `kill -9`) so the free seat is released upstream. A seat held by a
> dead process otherwise blocks the account for up to an hour.
