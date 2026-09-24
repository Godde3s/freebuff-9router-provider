import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Isolated config dir per test run.
process.env.FB9R_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fb9r-test-'));

const { startMockUpstream } = await import('./mock-upstream.js');
const { login, pollLoginUntilDone, startLoginCode, logout } = await import('../src/login.js');
const { loadCredentials, saveCredentials, clearCredentials, importFromOfficialCli } = await import('../src/credentials.js');

test('login: full flow stores credentials (code -> pending 401 -> user)', async () => {
  const mock = startMockUpstream({ loginStatusSeq: [401, 200] });
  process.env.FB9R_LOGIN_BASE = await mock.url;
  try {
    const cred = await login({ openBrowser: false });
    assert.equal(cred.authToken, 'tok_test_123');
    assert.equal(cred.email, 'test@example.com');
    assert.match(cred.fingerprintId, /^fb9r-/);
    const onDisk = loadCredentials();
    assert.equal(onDisk.authToken, 'tok_test_123');
    // two status polls happened (401 then 200)
    assert.equal(mock.state.loginStatusCalls, 2);
    // the code call carried our fingerprint
    const codeCall = mock.state.requests.find((r) => r.url === '/api/auth/cli/code');
    assert.match(codeCall.body.fingerprintId, /^fb9r-/);
  } finally {
    await mock.close();
  }
});

test('login: status polling echoes fingerprintId + fingerprintHash + expiresAt', async () => {
  const mock = startMockUpstream();
  process.env.FB9R_LOGIN_BASE = await mock.url;
  try {
    const started = await startLoginCode();
    await pollLoginUntilDone(started);
    const statusCall = mock.state.requests.find((r) => r.url.startsWith('/api/auth/cli/status'));
    assert.equal(statusCall.url.includes('fingerprintId=' + started.fingerprintId), true);
    assert.equal(statusCall.url.includes('fingerprintHash=fh_test'), true);
    assert.equal(statusCall.url.includes('expiresAt=' + started.expiresAt), true);
  } finally {
    await mock.close();
  }
});

test('credentials file is 0600 and JSON shape matches the CLI convention', async () => {
  saveCredentials({ authToken: 'tok_x', email: 'x@y.z' });
  const { credentialsPath } = await import('../src/credentials.js');
  const mode = fs.statSync(credentialsPath()).mode & 0o777;
  assert.equal(mode, 0o600);
  const raw = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
  assert.ok(raw.default);
  assert.equal(raw.default.authToken, 'tok_x');
});

test('import from official CLI credentials copies without touching their file', async () => {
  const manicode = path.join(os.homedir(), '.config', 'manicode');
  fs.mkdirSync(manicode, { recursive: true });
  const theirFile = path.join(manicode, 'credentials.json');
  fs.writeFileSync(theirFile, JSON.stringify({ default: { id: 'u1', name: 'N', email: 'n@x.y', authToken: 'their_token', fingerprintId: 'fp1' } }), { mode: 0o600 });
  const before = fs.readFileSync(theirFile, 'utf8');
  const cred = importFromOfficialCli();
  assert.equal(cred.authToken, 'their_token');
  assert.equal(fs.readFileSync(theirFile, 'utf8'), before);
  clearCredentials();
});

test('logout clears local credentials even when upstream fails', async () => {
  saveCredentials({ authToken: 'tok_y' });
  const mock = startMockUpstream();
  process.env.FB9R_LOGIN_BASE = await mock.url;
  try {
    const ok = await logout();
    assert.equal(ok, true);
    assert.equal(loadCredentials(), null);
    assert.ok(mock.state.requests.some((r) => r.url.startsWith('/api/auth/cli/logout')));
  } finally {
    await mock.close();
  }
});
