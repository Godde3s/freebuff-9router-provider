// Regression tests for the v1.1.0 review round: HTTP mapping of in-200
// admission refusals, gated DELETE /v1/session, body cap, mid-stream error
// frames, models `created`, versioned /health + index, and the session
// mutex that serializes seat transitions.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.FB9R_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fb9r-review-test-'));
const { saveCredentials } = await import('../src/credentials.js');
saveCredentials({ authToken: 'tok_test_123', email: 'test@example.com', id: 'acct_123' });

const { startMockUpstream } = await import('./mock-upstream.js');
const { createServer } = await import('../src/server.js');
const { VERSION } = await import('../src/constants.js');

async function once(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* sse */ }
  return { status: res.status, json, text };
}

async function boot(mock, opts = {}) {
  process.env.FB9R_API_BASE = await mock.url;
  const { server } = createServer({ port: 0, host: '127.0.0.1', ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    down: async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await mock.close();
    },
  };
}

test('review: /v1/models carries a numeric `created` (OpenAI-shape)', async () => {
  const mock = startMockUpstream();
  const { base, down } = await boot(mock);
  try {
    const r = await once(base + '/v1/models');
    assert.equal(r.status, 200);
    for (const m of r.json.data) {
      assert.equal(typeof m.created, 'number');
      assert.ok(Number.isInteger(m.created) && m.created > 0);
    }
  } finally { await down(); }
});

test('review: /health reports the package version; GET / lists endpoints', async () => {
  const mock = startMockUpstream();
  const { base, down } = await boot(mock);
  try {
    const h = await once(base + '/health');
    assert.equal(h.json.version, VERSION);
    const idx = await once(base + '/');
    assert.equal(idx.status, 200);
    assert.equal(idx.json.name, 'freebuff-9router-provider');
    assert.equal(idx.json.version, VERSION);
    assert.ok(Array.isArray(idx.json.endpoints) && idx.json.endpoints.length === 4);
  } finally { await down(); }
});

test('review: DELETE /v1/session honors the local api-key gate', async () => {
  const mock = startMockUpstream();
  const { base, down } = await boot(mock, { apiKey: 'sekret' });
  try {
    const denied = await once(base + '/v1/session', { method: 'DELETE' });
    assert.equal(denied.status, 401);

    const wrong = await once(base + '/v1/session', { method: 'DELETE', headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);

    // acquire a seat first so release has something to release
    await once(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer sekret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm', messages: [{ role: 'user', content: 'x' }] }),
    });
    const ok = await once(base + '/v1/session', { method: 'DELETE', headers: { Authorization: 'Bearer sekret' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.released, true);
    assert.equal(mock.state.deleteCalls, 1);
  } finally { await down(); }
});

test('review: oversized request body -> 413, upstream never called', async () => {
  const mock = startMockUpstream();
  const { base, down } = await boot(mock, { maxBodyBytes: 512 });
  try {
    const big = JSON.stringify({
      model: 'glm',
      messages: [{ role: 'user', content: 'x'.repeat(4096) }],
    });
    const r = await once(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: big,
    });
    assert.equal(r.status, 413);
    assert.equal(mock.state.chatCalls, 0);
    assert.equal(mock.state.admissionCalls, 0);
  } finally { await down(); }
});

test('review: in-200 admission refusal (rate_limited) maps to HTTP 429 with retryAfterMs', async () => {
  const mock = startMockUpstream({ admissionOkStatus: 'rate_limited' });
  const { base, down } = await boot(mock);
  try {
    const r = await once(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'rate_limited');
    assert.equal(r.json.error.retryAfterMs, 4321);
    assert.equal(mock.state.runStarts, 0); // never reached the run layer
  } finally { await down(); }
});

test('review: in-200 country_blocked maps to 403; model_unavailable to 503', async () => {
  for (const [status, want] of [['country_blocked', 403], ['model_unavailable', 503]]) {
    const mock = startMockUpstream({ admissionOkStatus: status });
    const { base, down } = await boot(mock);
    try {
      const r = await once(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'glm', messages: [{ role: 'user', content: 'x' }] }),
      });
      assert.equal(r.status, want, `${status} -> ${want}`);
      assert.equal(r.json.error.code, status);
    } finally { await down(); }
  }
});

test('review: mid-stream upstream failure emits an error frame + [DONE]', async () => {
  const mock = startMockUpstream({ chatAbortAfterFirst: true });
  const { base, down } = await boot(mock);
  try {
    const res = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm', stream: true, messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    assert.ok(text.includes('"content":"Hello"'), 'first chunk passed through');
    assert.ok(text.includes('"error"'), 'an explicit SSE error frame was emitted');
    assert.ok(text.endsWith('data: [DONE]\n\n'), 'stream still terminates cleanly');
    // finishRun happens after res.end(); give it a moment to land upstream.
    for (let i = 0; i < 100 && mock.state.runFinishes.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(mock.state.runFinishes[0]?.status, 'failed');
  } finally { await down(); }
});

test('review: concurrent chats on different models never race the seat (mutex)', async () => {
  const mock = startMockUpstream({ admissionDelayMs: 80 });
  const { base, down } = await boot(mock);
  try {
    const bodyFor = (model) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const [a, b] = await Promise.all([
      once(base + '/v1/chat/completions', bodyFor('glm')),
      once(base + '/v1/chat/completions', bodyFor('deepseek')),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);

    // Exactly one release + two admissions, and the release for seat 1
    // happened BEFORE the second admission (no interleaving).
    assert.equal(mock.state.admissionCalls, 2);
    assert.equal(mock.state.deleteCalls, 1);
    const order = mock.state.requests.map((r) => `${r.method} ${r.url}`);
    const firstAdmission = order.indexOf('POST /api/v1/freebuff/session/admission');
    const del = order.indexOf('DELETE /api/v1/freebuff/session');
    const secondAdmission = order.lastIndexOf('POST /api/v1/freebuff/session/admission');
    assert.ok(firstAdmission !== -1 && del !== -1 && secondAdmission !== -1);
    assert.ok(del < secondAdmission, `release(${del}) must precede re-admission(${secondAdmission})`);

    // Both chats used a valid, then-current instance id.
    const chats = mock.state.requests.filter((r) => r.url === '/api/v1/chat/completions');
    const ids = chats.map((c) => c.body.codebuff_metadata.freebuff_instance_id);
    assert.deepEqual(ids.sort(), ['inst_1', 'inst_2']);
  } finally { await down(); }
});

test('review: chat 409 superseded maps to 409, resets the seat, re-admits next call', async () => {
  const mock = startMockUpstream({ chat409Once: true });
  const { base, down } = await boot(mock);
  try {
    const call = () => once(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm', stream: false, messages: [{ role: 'user', content: 'x' }] }),
    });

    const first = await call();
    assert.equal(first.status, 409);
    assert.equal(first.json.error.code, 'superseded');
    // the failed run was still honestly reported
    assert.equal(mock.state.runFinishes[0]?.status, 'failed');

    // the seat was dropped locally: the next call re-admits (admission #2)
    const second = await call();
    assert.equal(second.status, 200);
    assert.equal(mock.state.admissionCalls, 2);
    const chats = mock.state.requests.filter((r) => r.url === '/api/v1/chat/completions');
    assert.equal(chats[0].body.codebuff_metadata.freebuff_instance_id, 'inst_1');
    assert.equal(chats[1].body.codebuff_metadata.freebuff_instance_id, 'inst_2');
  } finally { await down(); }
});
