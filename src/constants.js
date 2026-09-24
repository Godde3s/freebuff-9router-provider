// Wire constants and the Freebuff model catalog.
//
// Every value here mirrors the official Freebuff CLI wire behavior so that
// requests are shaped exactly like the first-party client sends them. No
// field below is used to disguise, spoof or evade anything: the provider
// runs ONE user account through the SAME official login and session flow
// the CLI uses, and it identifies itself with the upstream-required client
// opening (see CANONICAL_OPENING).

// Package version — kept in sync with package.json by hand (single source of
// truth for /health and the index route, no JSON import needed on Node 18).
export const VERSION = '1.1.1';

// Fixed timestamp for /v1/models entries (OpenAI clients expect a `created`).
export const MODELS_CREATED = 1756684800; // 2025-09-01T00:00:00Z

// Origins are read lazily so tests can point them at a mock upstream.
export const loginBase = () => process.env.FB9R_LOGIN_BASE || 'https://freebuff.com';
export const apiBase = () => process.env.FB9R_API_BASE || 'https://codebuff.com';

// The official CLI pins this UA on chat calls only (model-provider.ts).
export const CHAT_USER_AGENT = 'ai-sdk/openai-compatible/1.0.0/codebuff';
// Non-chat calls go out with the plain runtime UA, like the CLI's Bun fetch.
export const PLAIN_USER_AGENT = `node/${process.versions.node}`;

// Upstream free mode requires the first system message to open with one of
// the canonical Freebuff client identities. This provider uses the base3
// CLI opening (all our agents are base3-free-*). It is PREPENDED to your
// own system prompt — your instructions are never altered or removed.
export const CANONICAL_OPENING = 'You are Buffy, the coding agent behind Codebuff.';

// Poll cadence for the login status endpoint (login-flow.ts).
export const LOGIN_POLL_INTERVAL_MS = 5000;
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// Session keepalive cadence (use-freebuff-session.ts POLL_INTERVAL_ACTIVE_MS).
export const SESSION_POLL_INTERVAL_MS = 30_000;

// Model ids and the free-mode root agent each model must run under
// (FREEBUFF_*_AGENT_ID_BY_MODEL in the vendor tree). cost_mode is 'free'.
//
// NAMING NOTE (matches the official Freebuff catalog exactly):
// The upstream WIRE IDS are legacy/undated and do NOT track the served
// generation — Freebuff kept the ids so installed clients, saved picks and
// allowlists would not strand:
//   `deepseek/deepseek-v4-flash` serves **DeepSeek V4.1 Flash** (since
//   2026-09-10; upstream displayName 'DeepSeek V4.1 Flash').
//   `mimo/mimo-v2.5` serves **MiMo 2.6 Flash** (since 2026-09-21; upstream
//   comment: "the v2.5 in the id is history, not the model").
// `label` below IS the official displayName; aliases accept both the dated
// and undated spellings so every client keeps working.
export const MODELS = [
  {
    id: 'z-ai/glm-5.3-flash',
    agent: 'base3-free-glm-5-3-flash',
    label: 'GLM 5.3 Flash',
    aliases: ['glm-5.3-flash', 'glm-5.3', 'glm'],
    unmetered: true,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
    note: 'Deep reasoning, default model, unmetered at full access',
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    agent: 'base3-free-deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    aliases: ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek'],
    unmetered: true,
    note: 'Fast coding and tool use, unmetered at full access',
  },
  {
    id: 'mimo/mimo-v2.5',
    agent: 'base3-free-mimo',
    label: 'MiMo 2.6 Flash',
    aliases: ['mimo-2.6-flash', 'mimo-2.5', 'mimo-v2.5', 'mimo'],
    unmetered: true,
    note: 'Balanced, image support — also the upstream fallback model',
  },
  {
    id: 'upstage/solar-mini4',
    agent: 'base3-free-solar-mini4',
    label: 'Solar Mini 4',
    aliases: ['solar-mini-4', 'solar-mini4', 'solar'],
    unmetered: true,
    note: "Upstage's fast compact model, 524K context, text only",
  },
  {
    id: 'minimax/minimax-m3',
    agent: 'base3-free-minimax-m3',
    label: 'MiniMax M3',
    aliases: ['minimax-m3', 'minimax'],
    unmetered: false,
    note: 'Availability depends on current capacity',
  },
  {
    id: 'openai/gpt-6-luna',
    agent: 'base3-free-luna-6',
    label: 'GPT-6 Luna',
    aliases: ['gpt-6-luna', 'luna'],
    unmetered: false,
    note: 'US region or paid plans only',
  },
  {
    id: 'stealth/space-bunny-alpha',
    agent: 'base3-free-space-bunny-alpha',
    label: 'Space Bunny Alpha',
    aliases: ['space-bunny-alpha', 'space-bunny'],
    unmetered: false,
    note: 'Beta, 1M context, retains prompts for training',
  },
  {
    id: 'google/gemini-3.8-flash',
    agent: 'base3-free-gemini-3-8-flash',
    label: 'Gemini 3.8 Flash',
    aliases: ['gemini-3.8-flash', 'gemini'],
    unmetered: false,
    note: 'Paid plans only',
  },
];

export const DEFAULT_MODEL = MODELS[0].id; // GLM 5.3 Flash

export function resolveModel(name) {
  // Absent or empty -> the default model. A NON-STRING value (number, object,
  // boolean from a sloppy client) is a bad request, not a reason to silently
  // run a different model than the caller asked for.
  if (name == null || name === '') return DEFAULT_MODEL;
  if (typeof name !== 'string') return null;
  // Normalize: trim, lowercase, collapse whitespace runs to hyphens — so a
  // pasted official display name ("DeepSeek V4.1 Flash", "MiMo 2.6 Flash")
  // resolves exactly like its hyphenated alias ("deepseek-v4.1-flash").
  const n = name.trim().toLowerCase().replace(/\s+/g, '-');
  if (!n) return DEFAULT_MODEL;
  for (const m of MODELS) {
    if (m.id.toLowerCase() === n || m.aliases.includes(n)) return m.id;
  }
  return null;
}

export function modelEntry(id) {
  return MODELS.find((m) => m.id === id) || null;
}

// Clamp reasoning effort the way the CLI does for the GLM ladder.
export function clampEffort(model, effort) {
  const entry = modelEntry(model);
  if (!entry || !entry.efforts || !effort) return undefined;
  const e = String(effort).toLowerCase();
  if (entry.efforts.includes(e)) return e;
  if (e === 'medium' || e === 'none' || e === 'off') return 'low';
  if (e === 'auto') return undefined;
  return entry.defaultEffort;
}
