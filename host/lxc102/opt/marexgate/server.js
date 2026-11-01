'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const {
  openDb, initDb, loadConfig, getSetting, nowSec, sha256, randomToken,
  safeEqual, verifyPassword, audit, verifyTotp
} = require('./lib');

const HOST = '127.0.0.1';
const PORT = 8789;
const COOKIE = '__Host-marexgate';
const MAX_BODY = 32768;
const SESSION_ONLY_SECONDS = 12 * 3600;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 10;
const STEP_UP_MS = 5 * 60 * 1000;
const ALERTS_ENV = '/etc/marexcode/alerts.env';
const PROXY_KEY_PATH = '/etc/marexcode/proxy.key';

const config = loadConfig();
const db = openDb();
initDb(db);

const attempts = new Map();
const stepUps = new Map();
const ALLOWED_ORIGINS = new Set(
  Object.values((config.webauthn && config.webauthn.origins) || {}).map((o) => o.origin)
);
const lastLockAlert = new Map();
const alerts = loadAlerts();
const PROXY_KEY = fs.readFileSync(PROXY_KEY_PATH, 'utf8').trim();

function loadAlerts() {
  try {
    const out = {};
    for (const line of fs.readFileSync(ALERTS_ENV, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

function notify(text) {
  const token = alerts.TELEGRAM_TOKEN;
  const chat = alerts.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    const body = JSON.stringify({ chat_id: chat, text: `[Marexcode] ${text}` });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 5000
    }, (res) => res.resume());
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.end(body);
  } catch {}
}

function issueStepUp(deviceId) {
  const token = randomToken(24);
  const exp = Date.now() + STEP_UP_MS;
  stepUps.set(deviceId, { hash: sha256(token), exp });
  return { token, expires_at: Math.floor(exp / 1000) };
}

function validStepUp(deviceId, token) {
  const entry = stepUps.get(deviceId);
  if (!entry) return false;
  if (entry.exp <= Date.now()) {
    stepUps.delete(deviceId);
    return false;
  }
  if (typeof token !== 'string' || !token) return false;
  return safeEqual(sha256(token), entry.hash);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stepUps) {
    if (entry.exp <= now) stepUps.delete(key);
  }
}, 60000).unref();

function originAllowed(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

function clientIp(req) {
  const forwarded = req.headers['x-real-ip'];
  if (typeof forwarded === 'string' && net.isIP(forwarded)) return forwarded;
  let ip = req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid_json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function rateBlocked(req) {
  const entry = attempts.get(clientIp(req));
  if (!entry) return 0;
  if (entry.until && entry.until > Date.now()) return entry.until;
  if (entry.until && entry.until <= Date.now()) attempts.delete(clientIp(req));
  return 0;
}

function rateFail(req) {
  const key = clientIp(req);
  const entry = attempts.get(key) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= RATE_MAX) entry.until = Date.now() + RATE_WINDOW_MS;
  attempts.set(key, entry);
}

function rateReset(req) {
  attempts.delete(clientIp(req));
}

function cookieHeader(token, maxAge) {
  let value = `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict`;
  if (maxAge) value += `; Max-Age=${maxAge}`;
  return value;
}

function clearCookieHeader() {
  return `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function authDevice(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db.prepare(
    'SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL'
  ).get(sha256(token));
  if (!row) return null;
  if (row.trust_until <= nowSec()) return null;
  return { ...row, token };
}

function touchDevice(device, req) {
  const t = nowSec();
  if (t - device.last_seen_at < 60) return;
  db.prepare('UPDATE devices SET last_seen_at = ?, last_ip = ?, user_agent = ? WHERE id = ?')
    .run(t, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200), device.id);
}

function deviceName(value, req) {
  let name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name) {
    const ua = String(req.headers['user-agent'] || '');
    const match = ua.match(/(Firefox|Edg|Chrome|Safari|curl)\/[0-9.]+/);
    name = match ? match[0] : 'Navigateur';
  }
  return name.slice(0, 80);
}

function createDevice(req, res, { name, days }) {
  const t = nowSec();
  const id = randomToken(16);
  const token = randomToken(32);
  const csrf = randomToken(24);
  const trustUntil = t + (days > 0 ? days * 86400 : SESSION_ONLY_SECONDS);

  db.prepare(`INSERT INTO devices
    (id, name, token_hash, csrf_secret, created_at, last_seen_at, last_ip, user_agent, trust_until, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
    .run(id, name, sha256(token), csrf, t, t, clientIp(req),
      String(req.headers['user-agent'] || '').slice(0, 200), trustUntil);

  audit('device_created', { ip: clientIp(req), deviceId: id, detail: name });
  notify(`Nouvel appareil autorisé : ${name} (${clientIp(req)})`);

  return { id, name, token, csrf, trustUntil, days };
}

function publicDevice(row) {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    last_ip: row.last_ip,
    trust_until: row.trust_until,
    revoked_at: row.revoked_at
  };
}

function masterConfigured() {
  return Boolean(getSetting(db, 'master_hash'));
}

function totpEnabled() {
  return getSetting(db, 'totp_enabled') === '1';
}

async function checkMaster(req, body) {
  const okPassword = await verifyPassword(getSetting(db, 'master_hash'), String(body.password || ''));
  let okTotp = true;
  if (okPassword && totpEnabled()) {
    okTotp = verifyTotp(getSetting(db, 'totp_secret'), body.totp);
  }
  return { okPassword, okTotp };
}

async function handleLogin(req, res) {
  const blockedUntil = rateBlocked(req);
  if (blockedUntil) {
    const ip = clientIp(req);
    const last = lastLockAlert.get(ip) || 0;
    if (Date.now() - last > 10 * 60 * 1000) {
      lastLockAlert.set(ip, Date.now());
      notify(`Trop de tentatives de déverrouillage depuis ${ip}`);
    }
    const retry = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
    return sendJson(res, 429, { ok: false, error: 'rate_limited', retry_after: retry }, { 'Retry-After': String(retry) });
  }

  if (!masterConfigured()) {
    return sendJson(res, 503, { ok: false, error: 'master_not_configured' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, error: err.message || 'bad_request' });
  }

  const { okPassword, okTotp } = await checkMaster(req, body);

  if (!okPassword || !okTotp) {
    rateFail(req);
    audit('login_failure', { ip: clientIp(req), detail: okPassword ? 'bad_totp' : 'bad_password' });
    return sendJson(res, 401, { ok: false, error: okPassword ? 'invalid_totp' : 'invalid_password' });
  }

  rateReset(req);

  const maxDays = Number(getSetting(db, 'max_trust_days')) || 90;
  let days = body.trust_days === undefined ? Number(getSetting(db, 'trust_days')) || 30 : Number(body.trust_days);
  if (!Number.isFinite(days)) days = 0;
  days = Math.max(0, Math.min(Math.floor(days), maxDays));

  const name = deviceName(body.device_name, req);
  const device = createDevice(req, res, { name, days });
  audit('login_success', { ip: clientIp(req), deviceId: device.id, detail: name });

  return sendJson(res, 200, {
    ok: true,
    locked: false,
    device: { id: device.id, name: device.name },
    trust_until: device.trustUntil,
    trust_days: days,
    csrf: device.csrf,
    totp_enabled: totpEnabled()
  }, { 'Set-Cookie': cookieHeader(device.token, days > 0 ? days * 86400 : undefined) });
}

function handleStatus(req, res) {
  const configured = masterConfigured();
  const device = configured ? authDevice(req) : null;
  const base = {
    configured,
    totp_enabled: configured ? totpEnabled() : false,
    webauthn_enabled: true,
    passkeys: db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials').get().n,
    trust_days: Number(getSetting(db, 'trust_days')) || 30,
    max_trust_days: Number(getSetting(db, 'max_trust_days')) || 90,
    step_up_seconds: Math.floor(STEP_UP_MS / 1000)
  };
  if (!device) return sendJson(res, 200, { ...base, locked: true });
  touchDevice(device, req);
  return sendJson(res, 200, {
    ...base,
    locked: false,
    device: { id: device.id, name: device.name, created_at: device.created_at },
    trust_until: device.trust_until,
    csrf: device.csrf_secret
  });
}

function handleVerify(req, res) {
  const device = authDevice(req);
  if (!device) return sendJson(res, 401, { ok: false, error: 'locked' });
  res.writeHead(204, {
    'X-Marex-Device': device.id,
    'X-Marex-Trust-Until': String(device.trust_until),
    'Cache-Control': 'no-store'
  });
  res.end();
}

function handleDevices(req, res) {
  const device = authDevice(req);
  if (!device) return sendJson(res, 401, { ok: false, error: 'locked' });
  touchDevice(device, req);
  const rows = db.prepare(
    'SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC'
  ).all();
  return sendJson(res, 200, {
    ok: true,
    current: device.id,
    devices: rows.map((row) => ({ ...publicDevice(row), current: row.id === device.id }))
  });
}

async function handleStepUp(req, res) {
  const device = authDevice(req);
  if (!device) return sendJson(res, 401, { ok: false, error: 'locked' });
  if (!safeEqual(String(req.headers['x-csrf'] || ''), device.csrf_secret)) {
    return sendJson(res, 403, { ok: false, error: 'bad_csrf' });
  }
  if (!masterConfigured()) return sendJson(res, 503, { ok: false, error: 'master_not_configured' });

  const blockedUntil = rateBlocked(req);
  if (blockedUntil) {
    const retry = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
    return sendJson(res, 429, { ok: false, error: 'rate_limited', retry_after: retry }, { 'Retry-After': String(retry) });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, error: err.message || 'bad_request' });
  }

  const { okPassword, okTotp } = await checkMaster(req, body);
  if (!okPassword || !okTotp) {
    rateFail(req);
    audit('step_up_failure', { ip: clientIp(req), deviceId: device.id, detail: okPassword ? 'bad_totp' : 'bad_password' });
    return sendJson(res, 401, { ok: false, error: okPassword ? 'invalid_totp' : 'invalid_password' });
  }

  rateReset(req);
  const issued = issueStepUp(device.id);
  audit('step_up_success', { ip: clientIp(req), deviceId: device.id });
  return sendJson(res, 200, {
    ok: true,
    token: issued.token,
    expires_at: issued.expires_at,
    totp_enabled: totpEnabled()
  });
}

function handleRevoke(req, res, id) {
  const device = authDevice(req);
  if (!device) return sendJson(res, 401, { ok: false, error: 'locked' });
  if (!safeEqual(String(req.headers['x-csrf'] || ''), device.csrf_secret)) {
    return sendJson(res, 403, { ok: false, error: 'bad_csrf' });
  }

  const targetSelf = id === device.id;
  if (!targetSelf && !validStepUp(device.id, String(req.headers['x-step-up'] || ''))) {
    audit('revoke_denied_step_up', { ip: clientIp(req), deviceId: device.id, detail: id });
    return sendJson(res, 403, { ok: false, error: 'step_up_required' });
  }

  const t = nowSec();
  if (id === 'all') {
    const res1 = db.prepare('UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL').run(t);
    audit('devices_revoked_all', { ip: clientIp(req), deviceId: device.id });
    notify(`Tous les appareils ont été révoqués (${res1.changes})`);
  } else {
    const target = db.prepare('SELECT id, name FROM devices WHERE id = ? AND revoked_at IS NULL').get(id);
    if (!target) return sendJson(res, 404, { ok: false, error: 'unknown_device' });
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(t, id);
    audit('device_revoked', { ip: clientIp(req), deviceId: id, detail: `by:${device.id}` });
    notify(`Appareil révoqué : ${target.name} (par ${device.name})`);
  }
  const clearing = id === 'all' || targetSelf;
  return sendJson(res, 200, { ok: true }, clearing ? { 'Set-Cookie': clearCookieHeader() } : {});
}

function handleLogout(req, res) {
  const device = authDevice(req);
  if (device) {
    if (!safeEqual(String(req.headers['x-csrf'] || ''), device.csrf_secret)) {
      return sendJson(res, 403, { ok: false, error: 'bad_csrf' });
    }
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(nowSec(), device.id);
    audit('logout', { ip: clientIp(req), deviceId: device.id });
  }
  return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookieHeader() });
}

async function handleSshTicket(req, res) {
  const device = authDevice(req);
  if (!device) return sendJson(res, 401, { ok: false, error: 'locked' });
  if (!safeEqual(String(req.headers['x-csrf'] || ''), device.csrf_secret)) {
    return sendJson(res, 403, { ok: false, error: 'bad_csrf' });
  }
  let body = {};
  try {
    body = await readJson(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, error: err.message || 'bad_request' });
  }
  const sftpRoot = body && body.sftp_root === true;
  if (sftpRoot && !validStepUp(device.id, String(req.headers['x-step-up'] || ''))) {
    return sendJson(res, 403, { ok: false, error: 'step_up_required' });
  }
  const t = nowSec();
  const payload = { v: 1, sub: device.id, exp: t + 60, nonce: randomToken(12) };
  if (sftpRoot) payload.sftp_root = true;
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', PROXY_KEY).update(encoded).digest('base64url');
  audit('ssh_ticket_issued', { ip: clientIp(req), deviceId: device.id, detail: sftpRoot ? 'sftp_root' : null });
  return sendJson(res, 200, { ok: true, ticket: encoded + '.' + sig, expires_at: payload.exp });
}

const webAuthn = require('./webauthn')({
  db, config, audit, notify, clientIp, sendJson, readJson,
  createDevice, validStepUp, cookieHeader, authDevice
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'POST' && !originAllowed(req)) {
      audit('post_origin_denied', { ip: clientIp(req), detail: String(req.headers.origin || '').slice(0, 120) });
      return sendJson(res, 403, { ok: false, error: 'bad_origin' });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return handleStatus(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      return await handleLogin(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/logout') {
      return handleLogout(req, res);
    }
    if (url.pathname === '/verify') {
      return handleVerify(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/devices') {
      return handleDevices(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/step-up') {
      return await handleStepUp(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/ssh/ticket') {
      return await handleSshTicket(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/devices/revoke-all') {
      return handleRevoke(req, res, 'all');
    }
    const revokeMatch = url.pathname.match(/^\/devices\/([A-Za-z0-9_-]+)\/revoke$/);
    if (req.method === 'POST' && revokeMatch) {
      return handleRevoke(req, res, revokeMatch[1]);
    }
    if (req.method === 'POST' && url.pathname === '/webauthn/register/options') {
      return await webAuthn.registerOptions(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/webauthn/register/verify') {
      return await webAuthn.registerVerify(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/webauthn/login/options') {
      return await webAuthn.loginOptions(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/webauthn/login/verify') {
      return await webAuthn.loginVerify(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/webauthn/credentials') {
      return webAuthn.listCredentials(req, res);
    }
    const passkeyMatch = url.pathname.match(/^\/webauthn\/credentials\/([A-Za-z0-9_-]+)\/delete$/);
    if (req.method === 'POST' && passkeyMatch) {
      return webAuthn.deleteCredential(req, res, passkeyMatch[1]);
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
});

server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.listen(PORT, HOST, () => {
  console.log(`marexgate listening on ${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
