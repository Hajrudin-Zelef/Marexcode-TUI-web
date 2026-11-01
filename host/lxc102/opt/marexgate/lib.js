'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hash, verify, Algorithm } = require('@node-rs/argon2');

const STATE_DIR = process.env.STATE_DIRECTORY || '/var/lib/marexgate';
const CONFIG_PATH = process.env.MAREXGATE_CONFIG || '/etc/marexcode/security.json';
const DB_PATH = path.join(STATE_DIR, 'gate.db');
const AUDIT_PATH = path.join(STATE_DIR, 'audit.jsonl');

const DEFAULTS = {
  trust_days: 30,
  max_trust_days: 90,
  admin_tailscale_logins: [],
  webauthn: {
    rp_name: 'Marexcode',
    origins: {
      'marexcode.example.com': {
        rp_id: 'marexcode.example.com',
        origin: 'https://marexcode.example.com'
      },
      'neva.example-tailnet.ts.net': {
        rp_id: 'neva.example-tailnet.ts.net',
        origin: 'https://neva.example-tailnet.ts.net:8443'
      }
    }
  },
  ssh: {
    allowed_cidrs: ['100.64.0.0/10', '10.0.0.0/24', '192.168.1.0/24'],
    allowed_ports: [22, 2222],
    idle_timeout_min: 15,
    max_session_min: 480,
    max_sessions: 3,
    sftp: { max_bytes: 2147483648, preview_bytes: 262144, concurrent: 2 }
  }
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const wa = raw.webauthn || {};
    return {
      ...DEFAULTS,
      ...raw,
      webauthn: {
        ...DEFAULTS.webauthn,
        ...wa,
        origins: { ...DEFAULTS.webauthn.origins, ...(wa.origins || {}) }
      },
      ssh: { ...DEFAULTS.ssh, ...(raw.ssh || {}) }
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function openDb() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  return db;
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_secret TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_ip TEXT,
      user_agent TEXT,
      trust_until INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      event TEXT NOT NULL,
      ip TEXT,
      device_id TEXT,
      detail TEXT
    );
  `);
  migrateWebauthn(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      device_id TEXT,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      rp_id TEXT NOT NULL,
      name TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_webauthn_rp ON webauthn_credentials(rp_id);
  `);
  const cfg = loadConfig();
  if (getSetting(db, 'trust_days') == null) setSetting(db, 'trust_days', cfg.trust_days);
  if (getSetting(db, 'max_trust_days') == null) setSetting(db, 'max_trust_days', cfg.max_trust_days);
}

function migrateWebauthn(db) {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webauthn_credentials'"
  ).get();
  if (!table) return;
  const cols = db.prepare('PRAGMA table_info(webauthn_credentials)').all().map((c) => c.name);
  if (cols.includes('rp_id')) return;
  const count = db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials').get().n;
  if (count > 0) {
    throw new Error('webauthn_credentials migration required: table not empty');
  }
  db.exec('DROP TABLE webauthn_credentials');
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

const nowSec = () => Math.floor(Date.now() / 1000);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function hashPassword(password) {
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1
  });
}

async function verifyPassword(hashed, password) {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

function audit(event, { ip = null, deviceId = null, detail = null } = {}) {
  const record = { ts: nowSec(), event, ip, device_id: deviceId, detail };
  try {
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch {}
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input) {
  const clean = String(input).replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function totpAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function verifyTotp(secret, code, window = 1) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!secret || !/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    if (safeEqual(totpAt(secret, counter + i), clean)) return true;
  }
  return false;
}

function totpUri(secret, account = 'admin', issuer = 'Marexcode') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = {
  STATE_DIR,
  CONFIG_PATH,
  DB_PATH,
  AUDIT_PATH,
  DEFAULTS,
  loadConfig,
  openDb,
  initDb,
  getSetting,
  setSetting,
  nowSec,
  sha256,
  randomToken,
  safeEqual,
  hashPassword,
  verifyPassword,
  audit,
  generateTotpSecret,
  verifyTotp,
  totpUri
};
