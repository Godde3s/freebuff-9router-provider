// Chat wire layer: agent-run START/FINISH + the /api/v1/chat/completions call
// with the CLI's envelope. Honesty rules baked in:
//   * the canonical Freebuff client opening is PREPENDED to your system
//     prompt (upstream's free mode requires it); your own content is never
//     rewritten, and no "foreign marker" stripping of any kind exists here;
//   * ids are plain random values in the CLI's own shapes — no proxy-shaped
//     ids, no fingerprint games, no header tricks;
//   * cost_mode is always 'free' and wallet spend limit is always 0.

import crypto from 'node:crypto';
import { CANONICAL_OPENING, CHAT_USER_AGENT, apiBase, clampEffort, modelEntry } from './constants.js';
import { apiFetch, endpoints, UpstreamError } from './api.js';

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
function clientId() {
  // CLI shape: 13 lowercase base36 chars. Generated positionally (not via
  // Math.random().toString(36)) so the result can never contain '.', '-'
  // or exponent notation from tiny random values, which would break the
  // client-id shape upstream expects.
  let s = '';
  for (let i = 0; i < 13; i++) s += BASE36[crypto.randomInt(36)];
  return s;
}

// Prepend the canonical opening at position 0 of the first system message.
// PURE: the caller's message objects are never mutated (a shallow copy of
// every touched message is made) and the function is idempotent — a prompt
// that already opens with the canonical opening (string, or first text part
// of an array) is passed through untouched.
export function prependCanonicalOpening(messages) {
  const msgs = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  if (msgs.length === 0) {
    return [{ role: 'system', content: CANONICAL_OPENING }];
  }
  const firstSystemIdx = msgs.findIndex((m) => m && m.role === 'system');
  if (firstSystemIdx === -1) {
    return [{ role: 'system', content: CANONICAL_OPENING }, ...msgs];
  }
  const target = msgs[firstSystemIdx];

  if (typeof target.content === 'string') {
    if (target.content.trimStart().startsWith(CANONICAL_OPENING)) return msgs;
    target.content = target.content.trim()
      ? CANONICAL_OPENING + '\n\n' + target.content
      : CANONICAL_OPENING;
  } else if (Array.isArray(target.content)) {
    const firstText = target.content.find(
      (p) => p && p.type === 'text' && typeof p.text === 'string',
    );
    if (firstText && firstText.text.trimStart().startsWith(CANONICAL_OPENING)) return msgs;
    target.content = [{ type: 'text', text: CANONICAL_OPENING }, ...target.content];
  } else if (target.content == null) {
    target.content = CANONICAL_OPENING;
  } else {
    // Unsupported content shape: give the gate the canonical opening so the
    // request is well-formed rather than smuggling a guess.
    target.content = CANONICAL_OPENING;
  }
  return msgs;
}

// Build the request body exactly like the CLI's model-provider sends it.
export function buildEnvelope({
  model,
  messages,
  stream = true,
  instanceId,
  temperature,
  max_tokens,
  tools,
  tool_choice,
  reasoning_effort,
  stop,
  extra = {},
}) {
  const entry = modelEntry(model);
  const effort = clampEffort(model, reasoning_effort);

  const metadata = {
    run_id: crypto.randomUUID(),
    client_id: clientId(),
    ...(instanceId ? { freebuff_instance_id: instanceId } : {}),
    llm_step_number: '1',
    cost_mode: 'free',
    ...(effort ? { freebuff_reasoning_effort: effort } : {}),
  };

  const payload = {
    model,
    messages: prependCanonicalOpening(messages),
    stream: true, // upstream is always streamed; non-stream clients get aggregation
    codebuff_metadata: metadata,
    provider: { data_collection: 'deny' },
    ...extra,
  };
  if (temperature !== undefined) payload.temperature = temperature;
  if (max_tokens !== undefined) payload.max_tokens = max_tokens;
  if (tools?.length) payload.tools = tools;
  if (tool_choice !== undefined) payload.tool_choice = tool_choice;
  if (stop?.length) payload.stop = stop;
  if (effort) payload.reasoning_effort = effort;
  if (entry?.efforts && !effort && reasoning_effort == null) {
    // keep the model's own default; upstream applies it
  }
  return payload;
}

export class ChatClient {
  constructor({ token, session } = {}) {
    this.token = token;
    this.session = session; // FreebuffSession
    this.userId = null;
  }

  setToken(token) {
    this.token = token;
  }

  // POST /api/v1/agent-runs {action: START, agentId, ancestorRunIds: []}
  async startRun(agentId) {
    const res = await apiFetch(endpoints.agentRuns, {
      method: 'POST',
      token: this.token,
      headers: this.token ? { 'x-codebuff-api-key': this.token } : {},
      body: { action: 'START', agentId, ancestorRunIds: [] },
      timeoutMs: 20_000,
    });
    const runId = res.json?.runId;
    if (!runId) throw new UpstreamError({ status: res.status, code: 'no_run_id', message: 'agent-runs START returned no runId' });
    return runId;
  }

  // POST /api/v1/agent-runs {action: FINISH, ...} — honest terminal report.
  async finishRun({ runId, status = 'completed', steps = [], errorMessage }) {
    const payload = {
      action: 'FINISH',
      runId,
      status,
      totalSteps: steps.length,
      directCredits: 0,
      totalCredits: 0,
      steps,
    };
    if (errorMessage) payload.errorMessage = String(errorMessage).slice(0, 5000);
    try {
      await apiFetch(endpoints.agentRuns, {
        method: 'POST',
        token: this.token,
        headers: this.token ? { 'x-codebuff-api-key': this.token } : {},
        body: payload,
        timeoutMs: 20_000,
      });
    } catch {
      /* best effort, like the CLI's exit path */
    }
  }

  // POST /api/v1/chat/completions — returns the raw Response for SSE.
  // `timeoutMs` bounds TIME-TO-FIRST-BYTE only: once the SSE stream is
  // flowing there is no deadline (a long generation is not a stall), but an
  // upstream that never answers can no longer hang the request forever.
  async chatCompletion(payload, { signal, timeoutMs = 120_000 } = {}) {
    const url = apiBase().replace(/\/+$/, '') + endpoints.chat;
    const ctrl = new AbortController();
    const ttfbError = new UpstreamError({
      status: 504,
      code: 'upstream_timeout',
      message: `upstream chat did not respond within ${timeoutMs}ms`,
    });
    const timer = setTimeout(() => ctrl.abort(ttfbError), timeoutMs);
    const onAbort = () => ctrl.abort(signal.reason);
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'User-Agent': CHAT_USER_AGENT,
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(this.userId ? { 'x-freebuff-acting-user-id': this.userId } : {}),
        },
        body: JSON.stringify(payload),
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (!res.ok) {
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      const code = json?.status || json?.error || json?.code || null;
      let retryAfterMs = null;
      const ra = res.headers.get('retry-after');
      if (ra) {
        const secs = Number(ra);
        retryAfterMs = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(ra) - Date.now());
      }
      if (!retryAfterMs && Number.isFinite(json?.retryAfterMs)) retryAfterMs = json.retryAfterMs;
      if (!retryAfterMs && Number.isFinite(json?.retryAfterSeconds)) retryAfterMs = json.retryAfterSeconds * 1000;
      throw new UpstreamError({
        status: res.status,
        code: typeof code === 'string' ? code : null,
        message: json?.message || json?.error || text.slice(0, 300) || `HTTP ${res.status}`,
        retryAfterMs,
        body: json ?? text.slice(0, 500),
      });
    }
    return res;
  }
}

// Parse an upstream OpenAI-style SSE stream into {type, data} events.
export async function* iterateSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          if (data) yield data;
        }
      }
    }
    if (buf.startsWith('data:')) {
      const data = buf.slice(5).trim();
      if (data && data !== '[DONE]') yield data;
    }
  } finally {
    reader.releaseLock?.();
  }
}

// Aggregate a full SSE stream into one OpenAI-shaped completion object.
export async function aggregateStream(response) {
  const id = 'chatcmpl-' + crypto.randomUUID();
  let model;
  let content = '';
  let reasoning = '';
  let finish_reason = null;
  const toolCalls = [];
  const usage = {};
  let created = Math.floor(Date.now() / 1000);

  for await (const data of iterateSSE(response)) {
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    if (!model && chunk.model) model = chunk.model;
    if (chunk.created) created = chunk.created;
    if (chunk.usage) Object.assign(usage, chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.content) content += choice.delta.content;
    if (choice.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
    if (choice.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        const i = tc.index ?? 0;
        toolCalls[i] ??= { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finish_reason = choice.finish_reason;
  }

  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);
  return {
    id,
    object: 'chat.completion',
    created,
    model: model || 'unknown',
    choices: [{ index: 0, message, finish_reason: finish_reason || 'stop' }],
    ...(Object.keys(usage).length ? { usage } : {}),
  };
}
