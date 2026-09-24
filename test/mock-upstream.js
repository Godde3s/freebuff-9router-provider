// Shared mock upstream for tests. Implements the tiny slice of the wire the
// provider talks to: login code/status, session admission/refresh/release,
// agent-runs START/FINISH, chat completions (SSE), and /api/v1/me.

import http from 'node:http';
import crypto from 'node:crypto';

export function sseChunk({ model = 'z-ai/glm-5.3-flash', content, finish } = {}) {
  const chunk = {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: content != null ? { content } : {}, finish_reason: finish ?? null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function startMockUpstream({
  loginCodeStatus = 200,
  loginStatusSeq = null, // array of statuses to replay, then stay at last
  admissionStatus = 'active',
  admissionModel = 'z-ai/glm-5.3-flash',
  admissionHttpStatus = 200,
  chatStatus = 200,
  chatBody = null,       // raw response body override (SSE text)
  meBody = { id: 'acct_123', email: 'test@example.com' },
  runId = 'run_mock_1',
} = {}) {
  const state = {
    requests: [],
    loginStatusCalls: 0,
    admissionCalls: 0,
    refreshCalls: 0,
    deleteCalls: null,
    chatCalls: 0,
    lastChatPayload: null,
    lastChatHeaders: null,
    runStarts: 0,
    runFinishes: [],
    activeInstance: null,
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      state.requests.push(entry);

      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      // Login
      if (req.url === '/api/auth/cli/code') {
        return json(loginCodeStatus, {
          loginUrl: 'https://freebuff.com/login?code=test-code',
          fingerprintHash: 'fh_test',
          expiresAt: Date.now() + 3600_000,
        });
      }
      if (req.url?.startsWith('/api/auth/cli/status')) {
        state.loginStatusCalls++;
        if (loginStatusSeq) {
          const i = Math.min(state.loginStatusCalls - 1, loginStatusSeq.length - 1);
          const st = loginStatusSeq[i];
          if (st === 401) { res.writeHead(401); return res.end(); }
          return json(200, { user: { id: 'acct_123', name: 'Test User', email: 'test@example.com', authToken: 'tok_test_123' } });
        }
        return json(200, { user: { id: 'acct_123', name: 'Test User', email: 'test@example.com', authToken: 'tok_test_123' } });
      }
      if (req.url?.startsWith('/api/auth/cli/logout')) {
        return json(200, { ok: true });
      }

      // Whoami
      if (req.url?.startsWith('/api/v1/me')) {
        return json(200, meBody);
      }

      // Session
      if (req.url === '/api/v1/freebuff/session/admission') {
        state.admissionCalls++;
        state.activeInstance = 'inst_' + state.admissionCalls;
        if (admissionHttpStatus !== 200) {
          return json(admissionHttpStatus, {
            status: admissionStatus,
            message: 'mock admission limit',
            retryAfterMs: 1234,
          });
        }
        return json(200, {
          status: admissionStatus,
          instanceId: state.activeInstance,
          model: admissionModel,
          admittedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          remainingMs: 3600_000,
        });
      }
      if (req.url === '/api/v1/freebuff/session' && req.method === 'GET') {
        state.refreshCalls++;
        if (state.activeInstance) {
          return json(200, {
            status: 'active',
            instanceId: state.activeInstance,
            model: admissionModel,
            expiresAt: new Date(Date.now() + 1800_000).toISOString(),
            remainingMs: 1800_000,
          });
        }
        return json(404, { status: 'none' });
      }
      if (req.url === '/api/v1/freebuff/session' && req.method === 'DELETE') {
        state.deleteCalls = (state.deleteCalls || 0) + 1;
        state.activeInstance = null;
        return json(200, { status: 'ended' });
      }

      // Agent runs
      if (req.url === '/api/v1/agent-runs') {
        if (body?.action === 'START') {
          state.runStarts++;
          return json(200, { runId: runId + '_' + state.runStarts });
        }
        if (body?.action === 'FINISH') {
          state.runFinishes.push(body);
          return json(200, { ok: true });
        }
        return json(400, { error: 'bad action' });
      }

      // Chat
      if (req.url === '/api/v1/chat/completions') {
        state.chatCalls++;
        state.lastChatPayload = body;
        state.lastChatHeaders = req.headers;
        if (chatStatus !== 200) {
          return json(chatStatus, { status: 'rate_limited', message: 'mock rate limit', retryAfterMs: 1234 });
        }
        if (chatBody != null) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(chatBody);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({ content: 'Hello' }));
        res.write(sseChunk({ content: ' from' }));
        res.write(sseChunk({ content: ' Freebuff', finish: 'stop' }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  server.state = state;
  server.started = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.url = server.started.then(() => `http://127.0.0.1:${server.address().port}`);
  server.close = ((orig) => () => new Promise((r) => orig.call(server, r)))(server.close);
  return server;
}

export function uuid() {
  return crypto.randomUUID();
}
