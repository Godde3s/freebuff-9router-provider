// Local OpenAI-compatible server. 9router (or any OpenAI-speaking tool)
// points at http://127.0.0.1:<port>/v1 and this file does the rest:
//   GET  /v1/models            -> catalog
//   POST /v1/chat/completions  -> session ensure -> run START -> chat -> FINISH
//   GET  /health               -> login + session state
//   DELETE /v1/session         -> release the free seat
// Single account, single seat, no pooling, no header tricks. Errors from
// upstream are passed through verbatim so you always see the real reason.

import http from 'node:http';
import crypto from 'node:crypto';
import { MODELS, DEFAULT_MODEL, VERSION, MODELS_CREATED, resolveModel, modelEntry } from './constants.js';
import { loadCredentials } from './credentials.js';
import { fetchMe, FreebuffSession } from './session.js';
import { ChatClient, buildEnvelope, iterateSSE, aggregateStream } from './chat.js';
import { UpstreamError } from './api.js';

// Admission/chat states that arrive with an HTTP 200 (or as a code on a
// non-4xx) are mapped to the HTTP status they semantically are, so 9router
// and OpenAI-speaking clients handle them with their normal backoff logic.
const CODE_TO_HTTP = {
  rate_limited: 429,
  spend_limited: 429,
  ip_capped: 429,
  country_blocked: 403,
  banned: 403,
  consent_required: 403,
  free_mode_unavailable: 403,
  model_locked: 409,
  superseded: 409,
  session_superseded: 409,
  model_unavailable: 503,
};

function json(res, status, obj) {
  if (res.destroyed) return;
  const body = JSON.stringify(obj);
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-fb9r-provider': 'freebuff-9router-provider',
    });
    res.end(body);
  } catch {
    /* client vanished mid-write; nothing to do */
  }
}

function sseHeaders(res) {
  if (res.destroyed) return false;
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-fb9r-provider': 'freebuff-9router-provider',
    });
    return true;
  } catch {
    return false;
  }
}

function sseWrite(res, text) {
  if (res.destroyed) return;
  try {
    res.write(text);
  } catch {
    /* client vanished mid-stream */
  }
}

function errorBody(err) {
  const isUp = err instanceof UpstreamError;
  let status;
  if (isUp && err.status >= 400 && err.status <= 599) status = err.status;
  else if (isUp && err.code && CODE_TO_HTTP[err.code]) status = CODE_TO_HTTP[err.code];
  else status = 502;
  const code = isUp ? err.code || null : null;
  const message = isUp
    ? err.message + (code ? ` [${code}]` : '')
    : (err?.message || 'internal error');
  return { status, payload: { error: { message, type: 'upstream_error', code, ...(isUp && err.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}) } } };
}

// Constant-time local api-key comparison (length-independent via digests).
function keyMatches(presented, expected) {
  if (!expected) return true;
  if (!presented || typeof presented !== 'string') return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createServer({
  port = 8787,
  host = '127.0.0.1',
  apiKey = null,       // optional local gate: require this key on chat + session release
  token = null,
  maxBodyBytes = 32 * 1024 * 1024, // request body cap (413 beyond it)
  log = () => {},
} = {}) {
  const session = new FreebuffSession({ token, onError: (e) => log('session', e.message) });
  const chat = new ChatClient({ token, session });

  async function currentCredentials() {
    const cred = token ? { authToken: token } : loadCredentials();
    if (!cred?.authToken) return null;
    session.setToken(cred.authToken);
    chat.setToken(cred.authToken);
    if (!chat.userId) {
      const me = await fetchMe(cred.authToken);
      // Only ever our own account id, straight from /api/v1/me.
      chat.userId = me?.id || null;
    }
    return cred;
  }

  async function handleChat(req, res, body) {
    const cred = await currentCredentials();
    if (!cred) {
      return json(res, 401, { error: { message: 'not logged in — run `fb9r login` first', type: 'auth' } });
    }
    // Abort the upstream call if the local client disconnects mid-turn.
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort(new Error('client disconnected'));
    });

    const requested = body.model || DEFAULT_MODEL;
    const model = resolveModel(requested);
    if (!model) {
      return json(res, 400, {
        error: {
          message: `unknown model "${requested}". Available: ${MODELS.map((m) => m.id).join(', ')} (aliases allowed)`,
          type: 'invalid_request_error',
        },
      });
    }

    let seat;
    try {
      seat = await session.ensure(model);
    } catch (err) {
      const mapped = errorBody(err);
      // Admission states are terminal-for-this-request; make the message clear.
      return json(res, mapped.status, mapped.payload);
    }

    const entry = modelEntry(model);
    let runId = null;
    const startedAt = Date.now();
    try {
      runId = await chat.startRun(entry.agent);
    } catch (err) {
      const mapped = errorBody(err);
      return json(res, mapped.status, mapped.payload);
    }

    const wantsStream = body.stream === true;
    const payload = buildEnvelope({
      model,
      messages: body.messages,
      stream: true,
      instanceId: seat.instanceId,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      tools: body.tools,
      tool_choice: body.tool_choice,
      reasoning_effort: body.reasoning_effort,
      stop: body.stop,
    });
    payload.codebuff_metadata.run_id = runId; // same run across START/chat/FINISH

    let upstreamRes;
    try {
      upstreamRes = await chat.chatCompletion(payload, { signal: ac.signal });
    } catch (err) {
      await chat.finishRun({ runId, status: 'failed', steps: [], errorMessage: err?.message });
      // Seat-level rejections reset the local seat so the next call re-admits.
      const seatGone = err instanceof UpstreamError
        && (err.code === 'session_expired' || err.code === 'session_superseded' || err.code === 'superseded'
          || err.status === 410 || err.status === 428 || err.status === 409);
      if (seatGone) session.active = null;
      const mapped = errorBody(err);
      return json(res, mapped.status, mapped.payload);
    }

    if (!wantsStream) {
      try {
        const completion = await aggregateStream(upstreamRes);
        await chat.finishRun({
          runId,
          status: 'completed',
          steps: [{
            id: crypto.randomUUID(),
            stepNumber: 1,
            messageId: completion.id,
            status: 'completed',
            startTime: new Date(startedAt).toISOString(),
          }],
        });
        return json(res, 200, completion);
      } catch (err) {
        await chat.finishRun({ runId, status: 'failed', steps: [], errorMessage: err?.message });
        const mapped = errorBody(err);
        return json(res, mapped.status, mapped.payload);
      }
    }

    // Streaming: pass the upstream SSE frames through untouched and close
    // with [DONE] so standard OpenAI clients terminate cleanly. A mid-stream
    // upstream failure emits one OpenAI-shaped error frame before [DONE] so
    // the caller sees WHY the stream died instead of a silent truncation.
    if (!sseHeaders(res)) return;
    let hadError = false;
    try {
      for await (const data of iterateSSE(upstreamRes)) {
        sseWrite(res, `data: ${data}\n\n`);
      }
    } catch (err) {
      hadError = true;
      log('stream', err?.message);
      const mapped = errorBody(err);
      sseWrite(res, `data: ${JSON.stringify({ error: mapped.payload.error })}\n\n`);
    } finally {
      sseWrite(res, 'data: [DONE]\n\n');
      res.end();
      await chat.finishRun({
        runId,
        status: hadError ? 'failed' : 'completed',
        steps: hadError ? [] : [{
          id: crypto.randomUUID(),
          stepNumber: 1,
          messageId: null,
          status: 'completed',
          startTime: new Date(startedAt).toISOString(),
        }],
      });
    }
  }

  const server = http.createServer(async (req, res) => {
    // A client that vanishes mid-response must not crash the process with an
    // unhandled 'error' event on the response stream.
    res.on('error', () => {});
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    try {
      if (req.method === 'GET' && path === '/') {
        return json(res, 200, {
          name: 'freebuff-9router-provider',
          version: VERSION,
          endpoints: ['GET /v1/models', 'POST /v1/chat/completions', 'GET /health', 'DELETE /v1/session'],
          hint: 'add http://127.0.0.1:' + (port || 8787) + '/v1 as an OpenAI-compatible provider in 9router',
        });
      }

      if (req.method === 'GET' && path === '/health') {
        const cred = await currentCredentials();
        return json(res, 200, {
          ok: !!cred,
          loggedIn: !!cred,
          email: cred?.email || null,
          account: cred?.id || chat.userId || null,
          session: session.status(),
          models: MODELS.length,
          version: VERSION,
        });
      }

      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        return json(res, 200, {
          object: 'list',
          data: MODELS.map((m) => ({
            id: m.id,
            object: 'model',
            created: MODELS_CREATED,
            owned_by: 'freebuff',
            aliases: m.aliases,
            unmetered: !!m.unmetered,
            note: m.note,
          })),
        });
      }

      if (req.method === 'DELETE' && (path === '/v1/session' || path === '/session')) {
        // Releasing the seat is a mutating operation: when a local api key is
        // configured, callers must present it here too, or any local process
        // could keep knocking your seat out.
        if (apiKey) {
          const auth = req.headers.authorization || '';
          const key = auth.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
          if (!keyMatches(key, apiKey)) {
            return json(res, 401, { error: { message: 'invalid provider api key (FB9R_API_KEY)', type: 'auth' } });
          }
        }
        const ok = await session.release();
        return json(res, 200, { released: ok });
      }

      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
        if (apiKey) {
          const auth = req.headers.authorization || '';
          const key = auth.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
          if (!keyMatches(key, apiKey)) {
            return json(res, 401, { error: { message: 'invalid provider api key (FB9R_API_KEY)', type: 'auth' } });
          }
        }
        const chunks = [];
        let size = 0;
        let tooBig = false;
        for await (const c of req) {
          size += c.length;
          if (size > maxBodyBytes) {
            tooBig = true;
            chunks.length = 0; // keep draining the socket, discard content
          } else if (!tooBig) {
            chunks.push(c);
          }
        }
        if (tooBig) {
          return json(res, 413, { error: { message: `request body exceeds ${maxBodyBytes} bytes`, type: 'invalid_request_error' } });
        }
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
        }
        return await handleChat(req, res, body);
      }

      return json(res, 404, { error: { message: `no route: ${req.method} ${path}`, type: 'not_found' } });
    } catch (err) {
      log('http', err?.stack || err?.message);
      const mapped = errorBody(err);
      if (!res.headersSent) return json(res, mapped.status, mapped.payload);
      if (!res.writableEnded) res.end();
    }
  });

  server.on('close', () => {
    session.stop();
  });

  return { server, session, chat, port, host };
}
