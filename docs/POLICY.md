# Honest-client policy

Freebuff gives free access to strong models (GLM 5.3 Flash, DeepSeek V4.1
Flash, MiMo 2.6 Flash, Solar Mini 4 are unmetered at full access) funded by
text ads shown inside Freebuff's own products. Its servers run explicit
anti-abuse checks against third-party callers — that is documented in the
vendor's own tree (`foreign-client-signals.ts`, `docs/freebuff-abuse-
detection.md` references, the free-mode agent+model allowlist, proxy-shaped
client-id fingerprinting).

That creates a hard design line, and this project deliberately stands on
the honest side of it.

## What we do (and why it is fine)

- **Official login flow.** The code-in-URL browser flow is exactly what
  `freebuff login` performs; we add nothing to it.
- **Same wire shape as the CLI.** Requests carry the canonical Freebuff
  client opening, `cost_mode: "free"`, the correct base3 root agent per
  model, and CLI-shaped ids. This makes our requests *truthful*: they say
  "I am the Freebuff client" — and the first system message genuinely is
  the Freebuff client opening, prepended to your instructions, which the
  gate explicitly tolerates (prepend, never replace).
- **One account, one seat, released on exit.** The seat model exists so
  capacity is shared fairly; we keepalive while running and always DELETE
  on shutdown.
- **Errors pass through verbatim.** If upstream rate-limits, region-blocks
  or rejects a prompt, you see the real message and code — never a
  laundered one.

## What we refuse to implement (and why)

- **Foreign-marker stripping.** Some proxy projects rewrite your system
  prompt to remove strings like "You are Claude Code" or "You are Hermes
  Agent" so upstream's `foreign_system_prompt` check does not fire. That is
  defeating an access control, not interoperability. This provider never
  modifies your content; if a tool's prompt is rejected upstream, that is
  the service's gate and you see it plainly.
- **Account pools / token rotation / multi-accounting.** The free tier is
  per-account by design; pooling it is exactly what the "too many users on
  this IP" and spend-ceiling gates exist for.
- **TLS / fingerprint stealth.** Browser-impersonating TLS stacks and
  hardware-fingerprint forgery exist only to evade detection. We send a
  plain runtime UA on non-chat calls, the CLI's chat UA on chat, and a
  random stable login id — nothing forged.
- **Proxy-shaped ids.** Client ids that mimic specific real proxies or that
  dodge `looksLikeProxyClientId` patterns are a detection-evasion game. We
  mint ordinary CLI-shaped random ids, per run, like the CLI does.
- **Fake ad impressions.** The bridge renders no ads; it also sends no ad
  events, so no impression revenue is fabricated.

## Practical consequences

1. **Tools whose system prompts upstream flags may be rejected.** Claude
   Code, Hermes and similar harnesses open with recognizable identities.
   When that happens through this provider you get the upstream error, and
   the fix is to use tools/prompts the service accepts — not to mutate
   prompts. Plain chat clients, 9router's own basic-chat, custom prompts
   without harness markers, and Freebuff-adjacent usage all work.
2. **Region gates apply.** Free mode is region-gated upstream; this tool
   never fakes geography or uses VPN detection tricks.
3. **Free ≠ unlimited-for-scripts.** The unmetered models are unmetered for
   normal usage, but scripted abuse triggers exactly the ceilings upstream
   publishes (`rate_limited`, `spend_limited`, `ip_capped`). We surface
   them with their real `Retry-After` instead of working around them.

If you want the full unfiltered agent experience, use the official Freebuff
CLI/Desktop — this provider is for plugging the free models into 9router
with your own single account, honestly.
