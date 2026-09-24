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
import { MODELS, DEFAULT_MODEL, resolveModel, modelEntry } from './constants.js';
import { loadCredentials } from './credentials.js';
import { fetchMe, FreebuffSession } from './session.js';
import { ChatClient, buildEnvelope, iterateSSE, aggregateStream } from './chat.js';
import { UpstreamError } from './api.js';

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'x-fb9r-provider': 'freebuff-9router-provider',
  });
  res.end(body);
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'x-fb9r-provider': 'freebuff-9router-provider',
  });
}

function errorBody(err) {
  const isUp = err instanceof UpstreamError;
  const status = isUp && err.status >= 400 && err.status <= 599 ? err.status : 502;
  const code = isUp ? err.code || null : null;
  const message = isUp
    ? err.message + (code ? ` [${code}]` : '')
    : (err?.message || 'internal error');
  return { status, payload: { error: { message, type: 'upstream_error', code, ...(isUp && err.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}) } } };
}

export function createServer({
  port = 8787,
  host = '127.0.0.1',
  apiKey = null,       // optional local gate: require this key on chat calls
  token = null,
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
      if (err instanceof UpstreamError && (err.code === 'session_expired' || err.status === 410 || err.status === 428 || err.code === 'session_superseded')) {
        session.active = null; // next call re-admits
      }
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
    // with [DONE] so standard OpenAI clients terminate cleanly.
    sseHeaders(res);
    let hadError = false;
    try {
      for await (const data of iterateSSE(upstreamRes)) {
        res.write(`data: ${data}\n\n`);
      }
      res.write('data: [DONE]\n\n');
    } catch (err) {
      hadError = true;
      log('stream', err?.message);
      // Mid-stream errors can only be signalled by closing; clients already
      // received the headers, so end the stream honestly.
    } finally {
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
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key',
      });
      return res.end();
    }

    try {
      if (req.method === 'GET' && path === '/health') {
        const cred = await currentCredentials();
        return json(res, 200, {
          ok: !!cred,
          loggedIn: !!cred,
          email: cred?.email || null,
          account: cred?.id || chat.userId || null,
          session: session.status(),
          models: MODELS.length,
          version: '1.0.0',
        });
      }

      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        return json(res, 200, {
          object: 'list',
          data: MODELS.map((m) => ({
            id: m.id,
            object: 'model',
            owned_by: 'freebuff',
            aliases: m.aliases,
            unmetered: !!m.unmetered,
            note: m.note,
          })),
        });
      }

      if (req.method === 'DELETE' && (path === '/v1/session' || path === '/session')) {
        const ok = await session.release();
        return json(res, 200, { released: ok });
      }

      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
        if (apiKey) {
          const auth = req.headers.authorization || '';
          const key = auth.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
          if (key !== apiKey) {
            return json(res, 401, { error: { message: 'invalid provider api key (FB9R_API_KEY)', type: 'auth' } });
          }
        }
        const chunks = [];
        for await (const c of req) chunks.push(c);
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
      res.end();
    }
  });

  server.on('close', () => {
    session.stop();
  });

  return { server, session, chat, port, host };
}
