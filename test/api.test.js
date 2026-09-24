import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getEventListeners } from 'node:events';

const { apiFetch, UpstreamError, sleep } = await import('../src/api.js');

// AbortSignal is an EventTarget (no .listenerCount()); this works for both.
const listenerCount = (signal) => getEventListeners(signal, 'abort').length;

test('api: stalled upstream surfaces a typed 504 upstream_timeout (not a hang)', async () => {
  // A server that accepts connections and never responds.
  const blackhole = http.createServer(() => {});
  await new Promise((r) => blackhole.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${blackhole.address().port}`;
  try {
    const started = Date.now();
    await assert.rejects(
      () => apiFetch('/api/v1/me', { base, token: 't', timeoutMs: 150 }),
      (err) => {
        assert.ok(err instanceof UpstreamError);
        assert.equal(err.status, 504);
        assert.equal(err.code, 'upstream_timeout');
        return true;
      },
    );
    const took = Date.now() - started;
    assert.ok(took < 5000, `timeout fired in ${took}ms, not the 30s default`);
  } finally {
    blackhole.closeAllConnections?.();
    await new Promise((r) => blackhole.close(r));
  }
});

test('api: the timeout also covers the BODY read, not just the headers', async () => {
  // Respond with headers immediately, then never finish the body.
  const half = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{'); // partial body, no end
  });
  await new Promise((r) => half.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${half.address().port}`;
  try {
    await assert.rejects(
      () => apiFetch('/x', { base, timeoutMs: 150 }),
      (err) => {
        assert.ok(err instanceof UpstreamError);
        assert.equal(err.status, 504);
        assert.equal(err.code, 'upstream_timeout');
        return true;
      },
    );
  } finally {
    half.closeAllConnections?.();
    await new Promise((r) => half.close(r));
  }
});

test('sleep: leaves no abort listeners behind (no accumulation in poll loops)', async () => {
  const ac = new AbortController();
  await sleep(5, ac.signal);
  assert.equal(listenerCount(ac.signal), 0);

  // 30 iterations like a long login poll must not pile listeners up.
  for (let i = 0; i < 30; i++) await sleep(1, ac.signal);
  assert.equal(listenerCount(ac.signal), 0);

  // Aborting mid-sleep rejects with the signal's reason and still cleans up.
  const ac2 = new AbortController();
  ac2.abort(new Error('stop'));
  await assert.rejects(() => sleep(1000, ac2.signal), /stop/);
  assert.equal(listenerCount(ac2.signal), 0);
});

test('api: caller abort reason wins over the timeout', async () => {
  const blackhole = http.createServer(() => {});
  await new Promise((r) => blackhole.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${blackhole.address().port}`;
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('caller gave up')), 50);
  try {
    await assert.rejects(() => apiFetch('/x', { base, timeoutMs: 30_000, signal: ac.signal }), /caller gave up/);
    assert.equal(listenerCount(ac.signal), 0);
  } finally {
    blackhole.closeAllConnections?.();
    await new Promise((r) => blackhole.close(r));
  }
});
