// Credentials storage — same JSON shape and file mode discipline as the
// official CLI (credentials.default.{id,name,email,authToken,...}, 0600).
// Stored in this provider's OWN config dir; the official CLI's credentials
// file is only ever READ for optional import, never written.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function configDir() {
  if (process.env.FB9R_CONFIG_DIR) return process.env.FB9R_CONFIG_DIR;
  return path.join(os.homedir(), '.config', 'freebuff-9router');
}

export function credentialsPath() {
  return path.join(configDir(), 'credentials.json');
}

export function officialCliCredentialsPath() {
  return path.join(os.homedir(), '.config', 'manicode', 'credentials.json');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function healMode(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort, like the CLI */
  }
}

export function loadCredentials() {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return null;
  try {
    healMode(file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cred = raw?.default;
    if (!cred || !cred.authToken) return null;
    return cred;
  } catch {
    return null;
  }
}

export function saveCredentials(partial) {
  ensureDir(configDir());
  const file = credentialsPath();
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    existing = {};
  }
  const merged = { ...(existing.default || {}), ...partial };
  if (!merged.fingerprintId) merged.fingerprintId = newFingerprintId();
  fs.writeFileSync(file, JSON.stringify({ default: merged }, null, 2) + '\n', {
    mode: 0o600,
  });
  healMode(file);
  return merged;
}

export function clearCredentials() {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

// Optional: import the token you already logged in with via `freebuff login`
// (the official CLI). Read-only — we copy, never touch their file.
export function importFromOfficialCli() {
  const file = officialCliCredentialsPath();
  if (!fs.existsSync(file)) return null;
  try {
    healMode(file);
    const cred = JSON.parse(fs.readFileSync(file, 'utf8'))?.default;
    if (!cred?.authToken) return null;
    return saveCredentials({
      id: cred.id,
      name: cred.name,
      email: cred.email,
      authToken: cred.authToken,
      fingerprintId: cred.fingerprintId,
      fingerprintHash: cred.fingerprintHash,
    });
  } catch {
    return null;
  }
}

export function newFingerprintId() {
  // A stable, honest per-install identifier. Unlike the CLI we do NOT derive
  // it from hardware details — a random id stored once is enough for the
  // login flow to correlate code -> status -> account.
  return 'fb9r-' + crypto.randomBytes(16).toString('hex');
}
