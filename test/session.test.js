import test from 'node:test';
import assert from 'node:assert/strict';

const { startMockUpstream } = await import('./mock-upstream.js');
const { FreebuffSession, fetchMe } = await import('../src/session.js');
const { UpstreamError } = await import('../src/api.js');

test('session: admission acquires a seat and refresh keeps it alive', async () => {
  const mock = startMockUpstream({ admissionModel: 'z-ai/glm-5.3-flash' });
  const base = await mock.url;
  process.env.FB9R_API_BASE = base;
  try {
    const s = new FreebuffSession({ token: 'tok_test_123' });
    const seat = await s.ensure('z-ai/glm-5.3-flash');
    assert.equal(seat.instanceId, 'inst_1');
    assert.equal(mock.state.admissionCalls, 1);

    // ensure() with the same model refreshes, does not re-admit
    const again = await s.ensure('z-ai/glm-5.3-flash');
    assert.equal(again.instanceId, 'inst_1');
    assert.equal(mock.state.admissionCalls, 1);
    assert.ok(mock.state.refreshCalls >= 1);

    // admission carried the required headers
    const adm = mock.state.requests.find((r) => r.url === '/api/v1/freebuff/session/admission');
    assert.equal(adm.headers['x-freebuff-model'], 'z-ai/glm-5.3-flash');
    assert.equal(adm.headers['x-freebuff-wallet-spend-limit'], '0');
    assert.equal(adm.headers['x-freebuff-first-tab-discount'], '0');
    assert.ok(adm.headers['x-fb-timezone']);

    await s.stop();
    assert.equal(mock.state.deleteCalls, 1);
    const del = mock.state.requests.find((r) => r.method === 'DELETE');
    assert.equal(del.headers['x-freebuff-instance-id'], 'inst_1');
  } finally {
    await mock.close();
  }
});

test('session: switching models releases the old seat and re-admits', async () => {
  const mock = startMockUpstream();
  process.env.FB9R_API_BASE = await mock.url;
  try {
    const s = new FreebuffSession({ token: 'tok_test_123' });
    await s.ensure('z-ai/glm-5.3-flash');
    const seat2 = await s.ensure('deepseek/deepseek-v4-flash');
    assert.equal(seat2.instanceId, 'inst_2');
    assert.equal(mock.state.admissionCalls, 2);
    assert.equal(mock.state.deleteCalls, 1);
    await s.stop();
  } finally {
    await mock.close();
  }
});

test('session: non-active admission states surface as typed errors with code', async () => {
  const mock = startMockUpstream({ admissionHttpStatus: 429, admissionStatus: 'rate_limited' });
  process.env.FB9R_API_BASE = await mock.url;
  try {
    const s = new FreebuffSession({ token: 'tok_test_123' });
    await assert.rejects(
      () => s.ensure('z-ai/glm-5.3-flash'),
      (err) => {
        assert.ok(err instanceof UpstreamError);
        assert.equal(err.code, 'rate_limited');
        assert.equal(err.retryAfterMs, 1234);
        return true;
      },
    );
  } finally {
    await mock.close();
  }
});

test('me: token probe returns the account id for the acting-user header', async () => {
  const mock = startMockUpstream({ meBody: { id: 'acct_me', email: 'me@x.y' } });
  process.env.FB9R_API_BASE = await mock.url;
  try {
    const me = await fetchMe('tok_test_123');
    assert.equal(me.id, 'acct_me');
  } finally {
    await mock.close();
  }
});
