// Official Freebuff login: code-in-URL + status polling — the exact flow the
// CLI uses (POST /api/auth/cli/code -> open loginUrl -> GET /api/auth/cli/status).
// No device-code grant exists upstream and there are no refresh tokens:
// re-login simply means running this flow again.

import { apiFetch, endpoints, sleep } from './api.js';
import { LOGIN_POLL_INTERVAL_MS, LOGIN_TIMEOUT_MS } from './constants.js';
import { loadCredentials, saveCredentials, newFingerprintId } from './credentials.js';

export async function startLoginCode(token) {
  const cred = token ? { authToken: token } : loadCredentials();
  const fingerprintId = cred?.fingerprintId || newFingerprintId();
  const res = await apiFetch(endpoints.loginCode, {
    login: true,
    token: cred?.authToken,
    method: 'POST',
    body: { fingerprintId },
  });
  const { loginUrl, fingerprintHash, expiresAt } = res.json || {};
  if (!loginUrl) {
    throw new Error('login code request returned no loginUrl');
  }
  // Persist the fingerprint pair so status polling and later logout match.
  saveCredentials({ fingerprintId, ...(fingerprintHash ? { fingerprintHash } : {}) });
  return { loginUrl, fingerprintId, fingerprintHash, expiresAt };
}

export async function pollLoginUntilDone({ fingerprintId, fingerprintHash, expiresAt, onPending, signal }) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const q = new URLSearchParams({
      fingerprintId,
      ...(fingerprintHash ? { fingerprintHash } : {}),
      ...(expiresAt != null ? { expiresAt: String(expiresAt) } : {}),
    });
    let user = null;
    try {
      const res = await apiFetch(`${endpoints.loginStatus}?${q}`, { method: 'GET', login: true });
      user = res.json?.user ?? null;
    } catch (err) {
      if (err?.status !== 401) {
        // The CLI treats 401 as "still pending, keep polling"; anything else
        // warns and keeps polling too. We surface non-401s via onPending.
        onPending?.({ error: err });
      }
    }
    if (user && typeof user === 'object' && user.authToken) {
      return saveCredentials({
        id: user.id,
        name: user.name,
        email: user.email,
        authToken: user.authToken,
        fingerprintId,
        ...(fingerprintHash ? { fingerprintHash } : {}),
      });
    }
    onPending?.({ waiting: true });
    await sleep(LOGIN_POLL_INTERVAL_MS, signal);
  }
  throw new Error('login timed out — run `fb9r login` again');
}

export async function login({ openBrowser = true, onUrl, onPending, signal } = {}) {
  const { loginUrl, fingerprintId, fingerprintHash, expiresAt } = await startLoginCode();
  onUrl?.(loginUrl);
  console.log('\n  Open this link in your browser and approve the login:\n');
  console.log('  ' + loginUrl + '\n');
  if (openBrowser && process.stdout.isTTY) {
    const { spawn } = await import('node:child_process');
    const url = loginUrl;
    const cmd =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    try {
      spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      /* the URL is printed; user can open it manually */
    }
  }
  return pollLoginUntilDone({ fingerprintId, fingerprintHash, expiresAt, onPending, signal });
}

export async function logout() {
  const cred = loadCredentials();
  if (!cred) return false;
  try {
    await apiFetch(endpoints.loginLogout, {
      method: 'POST',
      login: true,
      token: cred.authToken,
      body: {
        userId: cred.id,
        fingerprintId: cred.fingerprintId,
        fingerprintHash: cred.fingerprintHash,
      },
      timeoutMs: 10_000,
    });
  } catch {
    /* the CLI also clears credentials even if the call fails */
  }
  return clearCredentials();
}

async function clearCredentials() {
  const { clearCredentials: clear } = await import('./credentials.js');
  return clear();
}
