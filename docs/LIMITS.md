# Freebuff free tier — the actual limits (v1.1.0)

Every fact below is taken from Freebuff's own public monorepo
(`CodebuffAI/freebuff`, `common/` + `cli/`), not guessed. Where a number is
server-configured and deliberately unpublished, that is stated. This page
answers two questions: **what the free tier really caps**, and **whether a
"different proxy" changes any of it** (short answer: only the plumbing — see
the last section).

---

## 1. The seat (free session)

| Property | Value |
|---|---|
| Seats per account | **1** (CLI and web run one session per user; Desktop is the only multi-session surface) |
| Session length | **~1 hour** (`expiresAt` / `remainingMs` on every refresh) |
| Keepalive | `GET /api/v1/freebuff/session` every **30 s ± 20% jitter** (the CLI's `POLL_INTERVAL_ACTIVE_MS`) |
| Model binding | **Immutable mid-session** — switching models requires release + re-admit (`model_locked` otherwise) |
| Grace window | After expiry the server briefly keeps the row (`gracePeriodEndsAt`): in-flight chat may finish, no new sessions |
| Takeover | Another CLI on the SAME account rotates the instance id → `superseded`, and the chat gate answers **409** for in-flight calls |

The single seat is the fair-share mechanism for a free product. This
provider honors it: one account, one seat, released on `Ctrl+C` /
`SIGTERM` / `DELETE /v1/session`.

## 2. Quota pools (`rate_limited`)

There are two kinds of models:

**Unmetered at full access** (no premium pool draw):
`z-ai/glm-5.3-flash`, `deepseek/deepseek-v4-flash`, `mimo/mimo-v2.5`,
`upstage/solar-mini4`.

**Premium pool** (metered per session start). The marketed FREE allowance
(`FREEBUFF_FREE_TIER_ALLOWANCE`, 2026-08-31):

| Window | Sessions | Reset |
|---|---|---|
| Day | **4** | midnight Pacific |
| Week | **14** | rolling 7 days |
| Month | **40** | 1st of the calendar month, Pacific |

- Weekly and monthly windows exist and are **displayed** today; the upstream
  code comments state day is the enforced pool and week/month enforcement is
  a later change. Treat the numbers as the published allowance, not a dare.
- Pools are **additive**: `base + referral + streak + promo + level`
  (`FreebuffSessionEntitlementBreakdown`). Referral reward is capped at
  **+1/day** (`FREEBUFF_REWARD_MAX_DAILY_SESSIONS = 1`).
- **DeepSeek premium models carry a one-a-day ceiling** on their own pool
  (server pool token; clients must group by `pool`, never match on it).
- A refusal arrives as `rate_limited` with `limit`, `recentCount`,
  `period` (`pacific_day` / `pacific_week` / `pacific_month`), `resetAt`
  and `retryAfterMs` = time to reset. It is a *quota*, not a tempo limit:
  being fast does not trigger it, being greedy does.

## 3. Money-shaped limits

- `spend_limited` — the cross-model provider-spend budget. The legacy
  provider-spend caps are **deprecated** ("no longer enforced or displayed"
  in the wire types); what remains is the **Freebucks meter** (since
  2026-09-02) for metered models: each premium session costs Freebucks, and
  a refusal can carry `freebucksShortfall: { price, balance }`. This
  provider always sends wallet spend limit `0` and `cost_mode: "free"` — it
  never spends, so it never charges you.
- Subscriptions exist (Starter / Plus / Pro, marketed totals 7/24/70 and
  11/40/140 and 15/80/250 sessions per day/week/month) — see the upgrade
  hint attached to refusals (`upgrade: { url, message }`).

## 4. IP and geography

- `ip_capped` — too many **distinct users with active free sessions on the
  same egress IP** (`FREEBUFF_IP_USER_CAP`, server-configured, value not
  public). Sent as **429**; admission-only; it clears when any one of those
  sessions ends — it is *not* tied to a quota reset. Shared NATs (offices,
  VPN exit nodes, dorms) hit this first.
- `country_blocked` — free mode runs on a country allowlist; requests from
  unknown/anonymized locations are refused **before** a session starts.
  The response carries `countryCode` and **IP-privacy signals**
  (`ipPrivacySignals`) — VPN/proxy/Tor detection is server-side. Terminal:
  no retry logic helps. This provider never fakes geography.

## 5. Trust levels (per-account)

Accounts sit on a ladder `new → verified → established → core`
(`FREEBUFF_TRUST_LEVELS`). The **thresholds and the limit matrix are
deliberately not in the public repo** — the vendor's own comment: *"a
published limit is a published target"*. New accounts get the strictest
pools; limits widen as the account ages/verifies/behaves. On infrastructure
failure the resolver **fails open** to `established` — proof these levels
gate real capacity.

## 6. Model availability windows

- `model_unavailable` — the model is closed right now:
  - limited-offer models run **"9am ET-5pm PT every day"**
    (`FREEBUFF_DEPLOYMENT_HOURS_LABEL`);
  - DeepSeek's expensive window: **weekdays 00:00–10:00 UTC** (derived from
    DeepSeek's published peak hours 01:00–04:00 + 06:00–10:00 UTC,
    Beijing Mon–Fri; weekends are always off-peak) — premium DeepSeek
    stands down for the whole window, including the 1 hour before;
  - `openai/gpt-6-luna` is **US-region or paid**; `google/gemini-3.8-flash`
    is **paid plans**; the exact `planRequiredModelIds` list is decided
    server-side per viewer (country-resolved);
  - `minimax/minimax-m3` depends on current capacity.
- `stealth/space-bunny-alpha` is beta, 1M context, and **retains prompts
  for training** — do not send anything private.

## 7. Free-mode chat gates (per request)

Enforced on `/api/v1/chat/completions`, all server-side:

| Gate | Rejection |
|---|---|
| `codebuff_metadata.cost_mode = "free"` | `free_mode_cost_mode_required` |
| agent+model pair on the free allowlist (`base3-free-*`) | `free_mode_invalid_agent_model` |
| first system message opens with a canonical Freebuff client identity | free-mode identity check |
| no recognizable foreign-harness markers (Claude Code, Hermes, …) | `foreign_system_prompt` |
| client-id does not fingerprint as a proxy | `looksLikeProxyClientId` |
| session seat valid + not superseded | `session_superseded` / 409 |

This provider satisfies the first three **honestly** (prepend the canonical
opening, never rewrite your content; CLI-shaped random ids; the correct
agent per model). The `foreign_system_prompt` gate it does **not** evade:
if your tool's harness prompt is flagged you see the exact upstream error.
Practical note: plain chat clients, 9router's basic chat, and custom prompts
without harness identity markers pass; full Claude Code / Hermes system
prompts may or may not, depending on what upstream currently flags.

## 8. Account-level

- `banned` — terminal, answered by every endpoint. Bots get banned; honest
  single-account use does not.
- `consent_required` — the account must accept something upstream first.
- **No refresh tokens exist.** When a token dies, re-run `fb9r login`.
- Desktop-only extras (not used here): free accounts get **1 slot-bound +
  3 multi-tab** sessions, subscribers 3 + 8 (`premium_slot_taken`).

---

## 9. "Can a new proxy lift these limits?" (the OpenCode question)

**Split the problem in two.**

**What a proxy CAN solve — compatibility.** Protocol translation
(OpenAI ↔ Anthropic ↔ Freebuff), streaming, model naming, auth plumbing,
client support. That is exactly what this provider and 9router do, and it
is solved: any OpenAI- or Anthropic-speaking tool can now use these models.
If "OpenCode needed a proxy" meant *plumbing*, then yes — same cure here,
already applied.

**What a proxy CANNOT solve — server-enforced limits.** The seat, the
pools, the IP cap, the country gate, the allowlist, trust levels and bans
are computed **server-side** from three inputs: your *account*, your *IP*,
and the *request shape*. A new proxy changes none of the three. The only
things a proxy could still do are evasion — multi-account pools (trips
`ip_capped` and the ban hammer), stripping harness markers (defeating an
access control), TLS/fingerprint forgery, VPN geo-games (detected via
`ipPrivacySignals`). Those violate the service's terms, get accounts banned,
and this project deliberately refuses to implement them. In other words:
**for Freebuff, a new proxy does not do what it (is imagined to) do for
OpenCode** — the limits that hurt live on Freebuff's servers, not in your
client.

**Legitimate ways to get more out of the free tier:**

1. Prefer the **unmetered** models (GLM 5.3 Flash, DeepSeek V4 Flash, MiMo,
   Solar Mini 4) — they are unmetered precisely so free users have a real
   default.
2. Earn pool bonuses: **referrals (+1/day), streaks, account level** — all
   additive on top of 4/14/40.
3. Wait out windows: `retryAfterMs`/`resetAt` are always surfaced verbatim
   by this provider; DeepSeek premium comes back at 10:00 UTC on weekdays.
4. **Subscribe** (Starter/Plus/Pro) or buy Freebucks if you need the
   premium lanes — that is what they gate for.
5. Let **9router route around refusals**: when Freebuff says `rate_limited`,
   a router's job is to fall back to another provider you own. Routing
   between *your own* providers is interoperability, not evasion.
6. BYOK / official APIs for anything heavy-duty.

---

*Basis: `common/src/types/freebuff-session.ts`, `common/src/constants/
freebuff-{subscriptions,peak-hours,standing,model-entitlements,models}.ts`,
`cli/src/hooks/use-freebuff-session.ts` — public repo export, read
2026-09-24. Server-configured values (`FREEBUFF_IP_USER_CAP`, trust
thresholds) are intentionally unpublished upstream and marked as such
here.*
