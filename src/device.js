// Opt-in device-key request signing (FB9R_DEVICE_SIGNING=1).
//
// Mirrors the official client half of the upstream device-signing contract
// (common/src/util/freebuff-device-signing.ts + freebuffDeviceSignaturePayload
// in common/src/types/freebuff-model-catalog.ts), one Ed25519 key pair per
// install, registered once per (account, API host) with
// POST /api/v1/freebuff/device-keys, and every signed request carries
//   x-freebuff-device-key  — the server-returned key id
//   x-freebuff-device-ts   — ms timestamp, the same value inside the payload
//   x-freebuff-device-sig  — base64url Ed25519 signature over
//       freebuff-device-v1 \n METHOD \n path \n ts \n hex(sha256(body)) \n fetchId
//
// Honesty rules, unchanged: the key identifies THIS install for THIS one
// account — exactly what the CLI's does. Nothing is spoofed, no other
// account's key is ever used, and signing never rewrites a request body.
//
// Failure policy copied from upstream: signing errors NEVER throw into the
// request path — every failure path returns {} and the request goes out
// unsigned, like the CLI's fallback mode. The default is UNSIGNED (legacy
// flow, accepted today); FB9R_DEVICE_SIGNING=1 turns the signed shape on.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configDir } from './credentials.js';
import {
  DEVICE_SIGNING_ENV,
  DEVICE_KEYS_PATH,
  DEVICE_KEY_HEADER,
  DEVICE_TIMESTAMP_HEADER,
  DEVICE_SIGNATURE_HEADER,
  DEVICE_CLIENT,
  DEVICE_SIGNATURE_VERSION,
  apiBase,
} from './constants.js';

const REGISTER_TIMEOUT_MS = 10_000;
const REGISTER_RETRY_MS = 5 * 60_000;
const REGISTER_UNSUPPORTED_RETRY_MS = 60 * 60_000;

export function signingEnabled() {
  return process.env[DEVICE_SIGNING_ENV] === '1';
}

function keyFilePath() {
  return path.join(configDir(), 'device-key.json');
}

// --- Encoding (same shapes as upstream: base64url, lowercase hex) -----------

function b64urlEncode(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function b64urlDecode(value) {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function bodyBytes(body) {
  if (body === null || body === undefined) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  return new TextEncoder().encode(String(body));
}

async function bodySha256Hex(body) {
  const digest = await crypto.subtle.digest('SHA-256', bodyBytes(body));
  return Buffer.from(digest).toString('hex');
}

// --- Key lifecycle -----------------------------------------------------------

let cached = null; // { record, privateKey } once loaded
let loading = null; // in-flight load/generate
const registering = new Map(); // scope -> Promise<string|null>
const retryAfter = new Map(); // scope -> epoch ms

function loadRecordFromDisk() {
  try {
    const raw = fs.readFileSync(keyFilePath(), 'utf8');
    const value = JSON.parse(raw);
    if (
      value?.version === 1 &&
      typeof value.publicKey === 'string' &&
      typeof value.privateKey === 'string'
    ) {
      return {
        version: 1,
        publicKey: value.publicKey,
        privateKey: value.privateKey,
        registrations: value.registrations && typeof value.registrations === 'object'
          ? { ...value.registrations }
          : {},
      };
    }
  } catch {
    /* absent or unreadable -> a new key only costs a registration */
  }
  return null;
}

function persistRecord(record) {
  const file = keyFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function ensureLoaded() {
  if (cached) return cached;
  loading ??= (async () => {
    try {
      const subtle = crypto.subtle;
      if (!subtle || typeof subtle.generateKey !== 'function') return null;
      let record = loadRecordFromDisk();
      let privateKey = null;
      if (record) {
        try {
          privateKey = await subtle.importKey(
            'pkcs8',
            b64urlDecode(record.privateKey),
            { name: 'Ed25519' },
            false,
            ['sign'],
          );
        } catch {
          privateKey = null;
        }
      }
      if (!record || !privateKey) {
        const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
        const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
        const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
        record = {
          version: 1,
          publicKey: b64urlEncode(publicKey),
          privateKey: b64urlEncode(pkcs8),
          registrations: {},
        };
        privateKey = await subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
        persistRecord(record);
      }
      cached = { record, privateKey };
      return cached;
    } catch {
      return null; // no usable Ed25519 -> signing stays off, requests go unsigned
    }
  })();
  return loading;
}

function scopeFor(token, url) {
  const host = new URL(url).host;
  const digest = crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
  return `${host}::${digest}`;
}

// POST /api/v1/freebuff/device-keys — plain fetch, unsigned, exactly like the
// upstream register() call. Returns the keyId or null (with a retry backoff).
async function registerKey(token, url, state) {
  const scope = scopeFor(token, url);
  const pending = registering.get(scope);
  if (pending) return pending;
  const attempt = (async () => {
    const fail = (retryMs) => {
      retryAfter.set(scope, Date.now() + retryMs);
      return null;
    };
    try {
      const res = await fetch(apiBase().replace(/\/+$/, '') + DEVICE_KEYS_PATH, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ publicKey: state.record.publicKey, client: DEVICE_CLIENT }),
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return fail(res.status === 404 || res.status === 405 ? REGISTER_UNSUPPORTED_RETRY_MS : REGISTER_RETRY_MS);
      }
      const json = await res.json().catch(() => null);
      const keyId = json && typeof json.keyId === 'string' ? json.keyId : null;
      if (!keyId) return fail(REGISTER_RETRY_MS);
      state.record.registrations[scope] = keyId;
      persistRecord(state.record);
      return keyId;
    } catch {
      return fail(REGISTER_RETRY_MS);
    } finally {
      registering.delete(scope);
    }
  })();
  registering.set(scope, attempt);
  return attempt;
}

async function keyIdFor(token, url, state) {
  const scope = scopeFor(token, url);
  if (state.record.registrations[scope]) return state.record.registrations[scope];
  const retryAt = retryAfter.get(scope);
  if (retryAt && Date.now() < retryAt) return null; // a refused registration is not retried on every request
  return registerKey(token, url, state);
}

// --- Public API ---------------------------------------------------------------

// The three device headers for one request, or {} (send it unsigned) whenever
// signing is off, unavailable, or not yet registered. Never throws.
export async function deviceRequestHeaders({ token, method, url, body } = {}) {
  try {
    if (!signingEnabled() || !token) return {};
    const state = await ensureLoaded();
    if (!state) return {};
    const keyId = await keyIdFor(token, url, state);
    if (!keyId) return {};
    const ts = Date.now();
    const payload = [
      DEVICE_SIGNATURE_VERSION,
      String(method || 'GET').toUpperCase(),
      new URL(url).pathname,
      String(ts),
      await bodySha256Hex(body ?? null),
      '', // fetchId: this provider holds no server catalog
    ].join('\n');
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      state.privateKey,
      new TextEncoder().encode(payload),
    );
    return {
      [DEVICE_KEY_HEADER]: keyId,
      [DEVICE_TIMESTAMP_HEADER]: String(ts),
      [DEVICE_SIGNATURE_HEADER]: b64urlEncode(new Uint8Array(signature)),
    };
  } catch {
    return {};
  }
}

// The server answered that the device key a request named is not one it knows:
// forget the registration so the next request registers again. Matched loosely
// on the error code, like upstream isFreebuffDeviceKeyUnknownError.
export function noteDeviceKeyError(code) {
  try {
    if (
      !code ||
      !/device[_-]?key/i.test(String(code)) ||
      !/unknown|not[_-]?found|invalid|unregistered/i.test(String(code))
    ) {
      return;
    }
    if (!cached) return;
    let changed = false;
    for (const scope of Object.keys(cached.record.registrations)) {
      if (scope.split('::')[0] === new URL(apiBase()).host) {
        delete cached.record.registrations[scope];
        changed = true;
      }
    }
    if (changed) persistRecord(cached.record);
  } catch {
    /* never throw */
  }
}

// Test hook: reset in-memory state (keys on disk are kept).
export function _resetForTests() {
  cached = null;
  loading = null;
  registering.clear();
  retryAfter.clear();
}
