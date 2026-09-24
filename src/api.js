// Thin fetch wrapper + upstream error classification.
// Error taxonomy mirrors the CLI's error-handling ladder so every failure is
// surfaced verbatim and honestly — nothing is retried in a way the service
// did not ask for, and nothing is disguised.

import { apiBase, loginBase, PLAIN_USER_AGENT } from './constants.js';

export class UpstreamError extends Error {
  constructor({ status, code, message, retryAfterMs, body }) {
    super(message || code || `upstream HTTP ${status}`);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code || null;
    this.retryAfterMs = retryAfterMs ?? null;
    this.body = body ?? null;
  }
}

function parseRetryAfter(res, body) {
  const h = res.headers?.get?.('retry-after');
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) return secs * 1000;
    const d = Date.parse(h);
    if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  }
  if (body && typeof body === 'object') {
    const n = body.retryAfterMs ?? body.retryAfterSeconds;
    if (Number.isFinite(n)) return n * (body.retryAfterMs != null ? 1 : 1000);
  }
  return null;
}

export async function apiFetch(path, {
  method = 'GET',
  body,
  token,
  base,
  login = false, // resolve against the login origin instead of the API origin
  headers = {},
  signal,
  timeoutMs = 30_000,
} = {}) {
  const origin = (base || (login ? loginBase() : apiBase())).replace(/\/+$/, '');
  const url = origin + (path.startsWith('/') ? path : '/' + path);
  const ctrl = new AbortController();
  // The timer covers the ENTIRE exchange (headers + body read) so a stalled
  // upstream can never hang a request forever. It surfaces as a typed 504.
  const timer = setTimeout(
    () => ctrl.abort(new UpstreamError({
      status: 504,
      code: 'upstream_timeout',
      message: `upstream did not respond within ${timeoutMs}ms`,
    })),
    timeoutMs,
  );
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        'User-Agent': PLAIN_USER_AGENT,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return await readJsonResponse(res);
  } finally {
    clearTimeout(timer);
    // Detach from the caller's signal: repeated calls over one long-lived
    // signal (login polling) must not accumulate listeners.
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function readJsonResponse(res) {
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    const code = json?.status || json?.error || json?.code || null;
    throw new UpstreamError({
      status: res.status,
      code: typeof code === 'string' ? code : null,
      message: json?.message || json?.error || text?.slice(0, 300) || `HTTP ${res.status}`,
      retryAfterMs: parseRetryAfter(res, json),
      body: json ?? text?.slice(0, 500),
    });
  }
  return { status: res.status, json, text, headers: res.headers };
}

// Endpoints as paths — resolved against the right origin at call time.
export const endpoints = {
  loginCode: '/api/auth/cli/code',
  loginStatus: '/api/auth/cli/status',
  loginLogout: '/api/auth/cli/logout',
  me: '/api/v1/me?fields=id,email',
  session: '/api/v1/freebuff/session',
  sessionAdmission: '/api/v1/freebuff/session/admission',
  agentRuns: '/api/v1/agent-runs',
  chat: '/api/v1/chat/completions',
};

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(done, ms);
    function done() {
      cleanup();
      resolve();
    }
    function onAbort() {
      cleanup();
      reject(signal.reason || new Error('aborted'));
    }
    function cleanup() {
      clearTimeout(t);
      // Detach after settle: polling loops share one signal and must not
      // accumulate a listener per iteration.
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
