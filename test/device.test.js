// Device-key signing: opt-in shape, upstream payload contract, honesty rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FB9R_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fb9r-dev-'));
process.env.FB9R_API_BASE = 'https://mock.local';
process.env.FB9R_LOGIN_BASE = 'https://mock.local';

const { deviceRequestHeaders, noteDeviceKeyError, signingEnabled, _resetForTests } = await import('../src/device.js');
const { DEVICE_KEY_HEADER, DEVICE_TIMESTAMP_HEADER, DEVICE_SIGNATURE_HEADER, DEVICE_SIGNATURE_VERSION } = await import('../src/constants.js');

const b64urlToBytes = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

test('signing is OFF by default and requests stay unsigned', async () => {
  _resetForTests();
  assert.equal(signingEnabled(), false);
  const h = await deviceRequestHeaders({ token: 't', method: 'GET', url: 'https://mock.local/api/v1/me' });
  assert.deepEqual(h, {});
});

test('FB9R_DEVICE_SIGNING=1 signs with the upstream v1 payload and registers once', async () => {
  _resetForTests();
  process.env[process.env.FB9R_DEVICE_SIGNING_ENV || 'FB9R_DEVICE_SIGNING'] = '1';

  // Mock registration endpoint on the mock host.
  const registeredBodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/api/v1/freebuff/device-keys')) {
      registeredBodies.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ keyId: 'key_abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };

  try {
    const url = 'https://mock.local/api/v1/chat/completions';
    const body = JSON.stringify({ model: 'z-ai/glm-5.3-flash' });
    const h1 = await deviceRequestHeaders({ token: 'tok', method: 'POST', url, body });
    assert.equal(h1[DEVICE_KEY_HEADER], 'key_abc');
    assert.ok(h1[DEVICE_TIMESTAMP_HEADER]);
    assert.ok(h1[DEVICE_SIGNATURE_HEADER]);

    // Exactly one registration for the same scope on the next call.
    await deviceRequestHeaders({ token: 'tok', method: 'POST', url, body });
    assert.equal(registeredBodies.length, 1);
    // Registration payload shape: base64url raw Ed25519 public key + honest client type.
    assert.equal(registeredBodies[0].client, 'cli');
    const pub = b64urlToBytes(registeredBodies[0].publicKey);
    assert.equal(pub.length, 32); // raw Ed25519 public key

    // Verify the signature independently against the documented payload.
    const ts = h1[DEVICE_TIMESTAMP_HEADER];
    const payload = [
      DEVICE_SIGNATURE_VERSION,
      'POST',
      new URL(url).pathname,
      ts,
      crypto.createHash('sha256').update(body).digest('hex'),
      '', // fetchId: no catalog held
    ].join('\n');
    const keyStore = JSON.parse(fs.readFileSync(path.join(process.env.FB9R_CONFIG_DIR, 'device-key.json'), 'utf8'));
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(keyStore.privateKey, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    });
    const ok = crypto.verify(null, Buffer.from(payload), privateKey, b64urlToBytes(h1[DEVICE_SIGNATURE_HEADER]));
    assert.equal(ok, true, 'signature verifies against the documented payload');
    assert.equal(ts, String(Number(ts))); // timestamp is ms-form, identical in payload
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.FB9R_DEVICE_SIGNING;
    _resetForTests();
  }
});

test('no token -> no headers; noteDeviceKeyError forgets the registration', async () => {
  _resetForTests();
  process.env.FB9R_DEVICE_SIGNING = '1';
  try {
    const h = await deviceRequestHeaders({ method: 'GET', url: 'https://mock.local/api/v1/me' });
    assert.deepEqual(h, {});

    // Prime a registration, then report an unknown-device-key error.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ keyId: 'key_x' }), { status: 200 });
    try {
      await deviceRequestHeaders({ token: 'tok2', method: 'GET', url: 'https://mock.local/api/v1/freebuff/session' });
      noteDeviceKeyError('device_key_unknown');
      // After forgetting, the next call registers again (fetch called again).
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ keyId: 'key_y' }), { status: 200 }); };
      await deviceRequestHeaders({ token: 'tok2', method: 'GET', url: 'https://mock.local/api/v1/freebuff/session' });
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    delete process.env.FB9R_DEVICE_SIGNING;
    _resetForTests();
  }
});
