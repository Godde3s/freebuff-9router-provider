import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.FB9R_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fb9r-srv-test-'));
const { saveCredentials } = await import('../src/credentials.js');
saveCredentials({ authToken: 'tok_test_123', email: 'test@example.com', id: 'acct_123' });

const { startMockUpstream } = await import('./mock-upstream.js');
const { createServer } = await import('../src/server.js');

async function once(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* sse */ }
  return { status: res.status, json, text };
}

test('server: /v1/models lists the catalog with aliases', async () => {
  const mock = startMockUpstream();
  process.env.FB9R_API_BASE = await mock.url;
  const { server, port } = createServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const r = await once(`http://127.0.0.1:${server.address().port}/v1/models`);
    assert.equal(r.status, 200);
    const ids = r.json.data.map((m) => m.id);
    assert.ok(ids.includes('z-ai/glm-5.3-flash'));
    assert.ok(ids.includes('deepseek/deepseek-v4-flash'));
    assert.ok(r.json.data.find((m) => m.id === 'z-ai/glm-5.3-flash').aliases.includes('glm-5.3-flash'));
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await mock.close();
  }
});

test('server: non-stream chat end-to-end (session + run + envelope + finish)', async () => {
  const mock = startMockUpstream();
  process.env.FB9R_API_BASE = await mock.url;
  const { server } = createServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await once(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3-flash', stream: false, messages: [{ role: 'user', content: 'say hi' }] }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.object, 'chat.completion');
    assert.equal(r.json.choices[0].message.content, 'Hello from Freebuff');

    // wire assertions
    const adm = mock.state.requests.find((q) => q.url === '/api/v1/freebuff/session/admission');
    assert.equal(adm.headers['x-freebuff-model'], 'z-ai/glm-5.3-flash');
    const chatReq = mock.state.requests.find((q) => q.url === '/api/v1/chat/completions');
    assert.equal(chatReq.headers['user-agent'], 'ai-sdk/openai-compatible/1.0.0/codebuff');
    assert.equal(chatReq.headers.authorization, 'Bearer tok_test_123');
    assert.equal(chatReq.headers['x-freebuff-acting-user-id'], 'acct_123');
    assert.equal(chatReq.body.model, 'z-ai/glm-5.3-flash');
    assert.equal(chatReq.body.stream, true);
    assert.equal(chatReq.body.codebuff_metadata.cost_mode, 'free');
    assert.equal(chatReq.body.codebuff_metadata.freebuff_instance_id, 'inst_1');
    // run ids line up: START -> chat.run_id -> FINISH.runId
    assert.equal(mock.state.runStarts, 1);
    assert.equal(chatReq.body.codebuff_metadata.run_id, 'run_mock_1_1');
    assert.equal(mock.state.runFinishes.length, 1);
    assert.equal(mock.state.runFinishes[0].status, 'completed');
    assert.equal(mock.state.runFinishes[0].runId, 'run_mock_1_1');
    // canonical opening present upstream, user content intact
    assert.ok(chatReq.body.messages[0].content.startsWith('You are Buffy'));
    assert.equal(chatReq.body.messages.find((m) => m.role === 'user').content, 'say hi');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await mock.close();
  }
});

test('server: streaming passes upstream SSE through to the client', async () => {
  const mock = startMockUpstream();
  process.env.FB9R_API_BASE = await mock.url;
  const { server } = createServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    assert.ok(text.includes('"content":"Hello"'));
    assert.ok(text.includes('"content":" from"'));
    assert.ok(text.endsWith('data: [DONE]\n\n'));
    // upstream saw the deepseek model id via alias
    assert.equal(mock.state.lastChatPayload.model, 'deepseek/deepseek-v4-flash');
    // session was released when we stopped? (not here — server still running)
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await mock.close();
  }
});

test('server: upstream 429 maps to HTTP 429 with code and retryAfterMs', async () => {
  const mock = startMockUpstream({ chatStatus: 429 });
  process.env.FB9R_API_BASE = await mock.url;
  const { server } = createServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await once(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm', stream: false, messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'rate_limited');
    assert.equal(r.json.error.retryAfterMs, 1234);
    // failed run was honestly reported
    assert.equal(mock.state.runFinishes[0]?.status, 'failed');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await mock.close();
  }
});

test('server: local api key gate blocks foreign callers', async () => {
  const mock = startMockUpstream();
  process.env.FB9R_API_BASE = await mock.url;
  const { server } = createServer({ port: 0, host: '127.0.0.1', apiKey: 'sekret' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = await once(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(bad.status, 401);

    const good = await once(new Request(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekret' },
      body: JSON.stringify({ model: 'glm', messages: [{ role: 'user', content: 'x' }] }),
    }));
    assert.equal(good.status, 200);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await mock.close();
  }
});

test('server: unknown model -> 400 with the catalog in the message', async () => {
  const mock = startMockUpstream();
  process.env.FB9R_API_BASE = await mock.url;
  const { server } = createServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await once(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-99', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(r.status, 400);
    assert.ok(r.json.error.message.includes('z-ai/glm-5.3-flash'));
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await mock.close();
  }
});

test('server: DELETE /v1/session releases the seat upstream', async () => {
  const mock = startMockUpstream();
  process.env.FB9R_API_BASE = await mock.url;
  const { server } = createServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // acquire then release
    await once(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm', messages: [{ role: 'user', content: 'x' }] }),
    });
    const rel = await once(base + '/v1/session', { method: 'DELETE' });
    assert.equal(rel.json.released, true);
    assert.equal(mock.state.deleteCalls, 1);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await mock.close();
  }
});
