// Free seat session lifecycle — admission (POST), refresh (GET), release
// (DELETE), exactly the calls the CLI makes, with the same headers and the
// same single-seat rule: ONE account holds ONE seat.

import { apiFetch, endpoints, UpstreamError } from './api.js';
import { SESSION_POLL_INTERVAL_MS } from './constants.js';

function timezoneHeader() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function sessionHeaders(extra = {}) {
  const tz = timezoneHeader();
  return {
    // Honest defaults: no wallet spend, no first-tab discount claim.
    'x-freebuff-wallet-spend-limit': '0',
    'x-freebuff-first-tab-discount': '0',
    ...(tz ? { 'x-fb-timezone': tz } : {}),
    ...extra,
  };
}

export class FreebuffSession {
  constructor({ token, onError } = {}) {
    this.token = token;
    this.onError = onError || (() => {});
    this.active = null; // { instanceId, model, expiresAt, remainingMs, raw }
    this.stopped = false;
    this._timer = null;
  }

  setToken(token) {
    if (token !== this.token) {
      this.token = token;
      this.active = null;
    }
  }

  status() {
    if (!this.active) return { status: 'none' };
    return {
      status: 'active',
      model: this.active.model,
      instanceId: this.active.instanceId,
      expiresAt: this.active.expiresAt,
      remainingMs: this.active.remainingMs,
      rateLimit: this.active.raw?.rateLimit,
      rateLimitsByModel: this.active.raw?.rateLimitsByModel,
      freebucks: this.active.raw?.freebucks,
      subscription: this.active.raw?.subscription,
    };
  }

  // Ensure a live seat on `model`. If a seat is held on another model,
  // release it and re-admit (model is immutable mid-session upstream).
  async ensure(model) {
    if (!this.token) throw new UpstreamError({ status: 401, message: 'not logged in — run `fb9r login`' });
    if (this.active) {
      const fresh = await this.refresh();
      if (fresh && this.active.model === model) return this.active;
      if (fresh && this.active.model !== model) {
        await this.release();
      }
    }
    return this.admit(model);
  }

  async admit(model) {
    const res = await apiFetch(endpoints.sessionAdmission, {
      method: 'POST',
      token: this.token,
      headers: sessionHeaders({ 'x-freebuff-model': model }),
      body: {},
      timeoutMs: 20_000,
    });
    const state = res.json || {};
    // Admission can answer 200 with a non-active status payload.
    if (state.status && state.status !== 'active') {
      throw new UpstreamError({
        status: 200,
        code: state.status,
        message: state.message || `session admission status: ${state.status}`,
        retryAfterMs: state.retryAfterMs,
        body: state,
      });
    }
    if (!state.instanceId) {
      throw new UpstreamError({ status: 200, code: 'no_instance', message: 'admission returned no instanceId', body: state });
    }
    this.active = {
      instanceId: state.instanceId,
      model: state.model || model,
      expiresAt: state.expiresAt,
      remainingMs: state.remainingMs,
      raw: state,
    };
    this._scheduleKeepalive();
    return this.active;
  }

  async refresh() {
    if (!this.active) return null;
    try {
      const res = await apiFetch(endpoints.session, {
        method: 'GET',
        token: this.token,
        headers: sessionHeaders({ 'x-freebuff-instance-id': this.active.instanceId }),
        timeoutMs: 20_000,
      });
      const state = res.json || {};
      if (state.status === 'active' && state.instanceId) {
        this.active = { ...this.active, expiresAt: state.expiresAt, remainingMs: state.remainingMs, raw: state };
        return this.active;
      }
      // ended / none / anything else -> seat is gone
      this.active = null;
      this._stopKeepalive();
      return null;
    } catch (err) {
      if (err instanceof UpstreamError && (err.status === 404)) {
        this.active = null;
        this._stopKeepalive();
        return null;
    }
      // transient: keep the seat, let the next call retry
      this.onError(err);
      return this.active;
    }
  }

  async release() {
    if (!this.active) return false;
    const instanceId = this.active.instanceId;
    this._stopKeepalive();
    this.active = null;
    try {
      const res = await apiFetch(endpoints.session, {
        method: 'DELETE',
        token: this.token,
        headers: sessionHeaders({ 'x-freebuff-instance-id': instanceId }),
        timeoutMs: 20_000,
      });
      return res.json?.status === 'ended' || res.status === 200;
    } catch {
      return false;
    }
  }

  _scheduleKeepalive() {
    this._stopKeepalive();
    if (this.stopped || !this.active) return;
    // ±20% symmetric jitter, like the CLI.
    const jitter = SESSION_POLL_INTERVAL_MS * (0.8 + Math.random() * 0.4);
    this._timer = setTimeout(() => {
      this.refresh()
        .then((live) => {
          if (live) this._scheduleKeepalive();
          else this.onError(new UpstreamError({ status: 0, code: 'session_ended', message: 'free session ended upstream' }));
        })
        .catch(() => {});
    }, jitter);
    this._timer.unref?.();
  }

  _stopKeepalive() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  stop() {
    this.stopped = true;
    this._stopKeepalive();
    return this.release();
  }
}

// GET /api/v1/me — the CLI's own token probe. Used once after login to show
// who is connected and to source the account's own id (never anyone else's).
export async function fetchMe(token) {
  try {
    const res = await apiFetch(endpoints.me, { token, timeoutMs: 15_000 });
    return res.json || null;
  } catch {
    return null;
  }
}
