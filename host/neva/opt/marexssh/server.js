'use strict';

// marexssh — proxy SSH/WebSocket + SFTP pour Marexcode Web.
// Écoute uniquement sur 127.0.0.1:8791, exposé au tailnet via
// `tailscale serve --set-path=/ssh`. Triple contrôle :
//   1. en-tête Tailscale-User-Login (injecté par Serve) = admin configuré ;
//   2. ticket HMAC court, délivré par le gate après déverrouillage maître ;
//   3. destination dans les CIDR autorisés + port autorisé.
// SFTP : même connexion SSH, chemins confinés (home, ou racine après step-up),
// pas de suppression/chmod/éditeur ; upload/download/preview HTTP authentifiés
// par le jeton de session.
// Aucun secret (mot de passe/clé) n'est journalisé ni stocké.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns');
const crypto = require('node:crypto');
const { Transform, pipeline } = require('node:stream');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');

const HOST = '127.0.0.1';
const PORT = 8791;
const CONFIG_PATH = '/etc/marexssh/config.json';
const KEY_PATH = '/etc/marexssh/proxy.key';
const STATE_DIR = process.env.STATE_DIRECTORY || '/var/lib/marexssh';
const KNOWN_PATH = path.join(STATE_DIR, 'known_hosts.json');
const AUDIT_PATH = path.join(STATE_DIR, 'audit.jsonl');
const GATE_HOST = '10.0.0.102';
const GATE_PORT = 80;
const GATE_PATH = '/_gate/verify-neva';
const GATE_HOST_HEADER = 'marexcode.example.com';

const DEFAULTS = {
  admins: ['admin@example.com'],
  allowed_cidrs: ['100.64.0.0/10', '10.0.0.0/24', '192.168.1.0/24'],
  allowed_ports: [22, 2222],
  idle_timeout_min: 15,
  max_session_min: 480,
  max_sessions: 3,
  max_sessions_per_login: 6,
  ticket_ttl_sec: 60,
  ready_timeout_sec: 25,
  sftp: { max_bytes: 2147483648, preview_bytes: 262144, concurrent: 2, max_entries: 2000 }
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...raw, sftp: { ...DEFAULTS.sftp, ...(raw.sftp || {}) } };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

const config = loadConfig();
const PROXY_KEY = fs.readFileSync(KEY_PATH, 'utf8').trim();
const nowSec = () => Math.floor(Date.now() / 1000);

function audit(event, fields = {}) {
  try {
    fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: nowSec(), event, ...fields }) + '\n', { mode: 0o600 });
  } catch {}
}

function loadKnown() {
  try { return JSON.parse(fs.readFileSync(KNOWN_PATH, 'utf8')); } catch { return {}; }
}
let knownHosts = loadKnown();
function saveKnown() {
  try {
    const tmp = KNOWN_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(knownHosts, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, KNOWN_PATH);
  } catch (err) {
    audit('ssh_known_hosts_save_failed', { error: err.message });
  }
}

const usedNonces = new Map();
function verifyTicket(ticket) {
  if (typeof ticket !== 'string' || ticket.length > 2048) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', PROXY_KEY).update(body).digest();
  let got;
  try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || payload.v !== 1) return null;
  if (typeof payload.sub !== 'string' || payload.sub.length > 64) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec()) return null;
  if (typeof payload.nonce !== 'string' || payload.nonce.length > 64) return null;
  if (usedNonces.has(payload.nonce)) return null;
  usedNonces.set(payload.nonce, payload.exp + 120);
  return payload;
}
setInterval(() => {
  const t = nowSec();
  for (const [nonce, exp] of usedNonces) if (exp <= t) usedNonces.delete(nonce);
  for (const [token, entry] of downloadTokens) if (entry.exp <= t) downloadTokens.delete(token);
}, 60000).unref();

function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function inCidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}
function allowedIp(ip) {
  if (!net.isIPv4(ip)) return false;
  return config.allowed_cidrs.some((cidr) => inCidr(ip, cidr));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

function routePath(url) {
  let p = url.pathname;
  if (p === '/ssh' || p === '/ssh/') return '/';
  if (p.startsWith('/ssh/')) p = p.slice(4);
  return p;
}
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (fwd) return fwd;
  let ip = req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}
function loginOf(req) {
  const login = req.headers['tailscale-user-login'];
  return typeof login === 'string' ? login.trim().toLowerCase() : '';
}
function identityAllowed(req) {
  const login = loginOf(req);
  return Boolean(login) && config.admins.map((a) => a.toLowerCase()).includes(login);
}

const sessionsByDevice = new Map();
const sessionsByLogin = new Map();
function bump(map, key, delta) {
  const value = (map.get(key) || 0) + delta;
  if (value <= 0) map.delete(key);
  else map.set(key, value);
}

const sftpSessions = new Map();     // token -> session
const downloadTokens = new Map();   // token -> { session, path, name, exp }

function serverError(ws, code, message) {
  try { ws.send(JSON.stringify({ type: 'error', code, message })); } catch {}
}
function closeWithError(ws, code, message) {
  serverError(ws, code, message);
  try { ws.close(1008, code); } catch {}
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = routePath(url);
  if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });
  if (p === '/sftp/upload' || p === '/sftp/preview' || p === '/sftp/download') {
    if (!identityAllowed(req)) return sendJson(res, 403, { ok: false, error: 'identity_required' });
    return handleSftpHttp(req, res, p, url);
  }
  return sendJson(res, 404, { ok: false, error: 'not_found' });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (routePath(url) !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  if (!identityAllowed(req)) {
    audit('ssh_denied_identity', { login: loginOf(req) || null, ip: clientIp(req) });
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// ---------- gate revalidation ----------
function gateVerify(cookie) {
  return new Promise((resolve) => {
    const req = http.request({
      host: GATE_HOST, port: GATE_PORT, path: GATE_PATH, method: 'GET',
      headers: { Host: GATE_HOST_HEADER, Cookie: cookie || '' },
      timeout: 4000
    }, (res) => {
      res.resume();
      if (res.statusCode === 204) resolve('ok');
      else if (res.statusCode === 401) resolve('revoked');
      else resolve('unknown');
    });
    req.on('timeout', () => { req.destroy(); resolve('unknown'); });
    req.on('error', () => resolve('unknown'));
    req.end();
  });
}

// ---------- SFTP helpers ----------
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (err, value) => (err ? reject(err) : resolve(value)));
  });
}

function insideRoot(root, p) {
  if (root === '/') return p.startsWith('/');
  return p === root || p.startsWith(root + '/');
}

async function resolvePath(session, input) {
  if (typeof input !== 'string' || !input.startsWith('/') || input.includes('\0')) {
    throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
  }
  let real;
  try {
    real = await sftpCall(session.sftp, 'realpath', input);
  } catch {
    const dir = path.posix.dirname(input);
    const base = path.posix.basename(input);
    if (!base || base === '.' || base === '..' || base.includes('/')) {
      throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
    }
    const realDir = await sftpCall(session.sftp, 'realpath', dir);
    real = path.posix.join(realDir, base);
  }
  if (!insideRoot(session.root, real)) {
    throw Object.assign(new Error('outside_root'), { code: 'outside_root' });
  }
  return real;
}

async function existingPath(session, input) {
  const real = await sftpCall(session.sftp, 'realpath', input);
  if (!insideRoot(session.root, real)) {
    throw Object.assign(new Error('outside_root'), { code: 'outside_root' });
  }
  return real;
}

function entryType(mode) {
  const kind = mode & S_IFMT;
  if (kind === S_IFDIR) return 'd';
  if (kind === S_IFLNK) return 'l';
  return '-';
}

async function listDir(session, dir) {
  const real = await resolvePath(session, dir);
  const entries = await sftpCall(session.sftp, 'readdir', real);
  const mapped = entries.slice(0, config.sftp.max_entries).map((e) => ({
    name: e.filename,
    type: entryType(e.attrs.mode),
    size: Number(e.attrs.size) || 0,
    mtime: Number(e.attrs.mtime) || 0,
    mode: e.attrs.mode & 0o777
  }));
  mapped.sort((a, b) => (a.type === 'd' ? 0 : 1) - (b.type === 'd' ? 0 : 1) || a.name.localeCompare(b.name));
  return { path: real, entries: mapped, truncated: entries.length > mapped.length };
}

function guessType(name) {
  const ext = path.extname(name).toLowerCase();
  const images = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  if (images[ext]) return { kind: 'image', type: images[ext] };
  const text = new Set(['.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh', '.yml', '.yaml', '.toml', '.ini', '.conf', '.cfg', '.log', '.csv', '.html', '.htm', '.css', '.xml', '.sql', '.env', '.gitignore', '.dockerfile', '.service', '.jsonl', '.lock']);
  if (text.has(ext) || !ext) return { kind: 'text', type: 'text/plain; charset=utf-8' };
  return { kind: 'other', type: 'application/octet-stream' };
}

function readAll(stream, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(Object.assign(new Error('too_large'), { code: 'too_large' }));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ---------- HTTP SFTP endpoints ----------
async function handleSftpHttp(req, res, route, url) {
  try {
    if (route === '/sftp/download') return await handleDownload(req, res, url);
    if (route === '/sftp/preview') return await handlePreview(req, res);
    if (route === '/sftp/upload') return await handleUpload(req, res);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 400, { ok: false, error: err.code || 'error' });
    else res.destroy();
  }
}

function sessionFromHeader(req) {
  const token = String(req.headers['x-marex-sftp'] || '');
  if (!token) return null;
  const session = sftpSessions.get(token);
  if (!session || session.closed || !session.sftp) return null;
  return session;
}

async function handleUpload(req, res) {
  const session = sessionFromHeader(req);
  if (!session) return sendJson(res, 401, { ok: false, error: 'bad_session' });
  if (session.uploads >= config.sftp.concurrent) return sendJson(res, 429, { ok: false, error: 'too_many_uploads' });

  let target;
  try {
    target = decodeURIComponent(String(req.headers['x-marex-path'] || ''));
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad_path' });
  }
  const overwrite = String(req.headers['x-marex-overwrite'] || '') === '1';

  let real;
  try { real = await resolvePath(session, target); } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.code || 'bad_path' });
  }

  let exists = false;
  try { await sftpCall(session.sftp, 'stat', real); exists = true; } catch {}
  if (exists && !overwrite) return sendJson(res, 409, { ok: false, error: 'exists', path: real });

  session.uploads += 1;
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, enc, cb) {
      bytes += chunk.length;
      if (bytes > config.sftp.max_bytes) {
        cb(Object.assign(new Error('too_large'), { code: 'too_large' }));
        return;
      }
      cb(null, chunk);
    }
  });
  const ws = session.sftp.createWriteStream(real, { flags: 'w' });
  session.streams.add(ws);
  let finished = false;
  function done(err) {
    if (finished) return;
    finished = true;
    session.streams.delete(ws);
    session.uploads = Math.max(0, session.uploads - 1);
    if (err) {
      if (!res.headersSent) sendJson(res, err.code === 'too_large' ? 413 : 500, { ok: false, error: err.code || 'upload_failed' });
      else res.destroy();
      return;
    }
    audit('ssh_sftp_upload', { login: session.login, device: session.device, detail: `${real};${bytes}` });
    sendJson(res, 200, { ok: true, path: real, size: bytes });
  }
  pipeline(req, counter, ws, done);
}

async function handleDownload(req, res, url) {
  const token = url.searchParams.get('t') || '';
  const entry = downloadTokens.get(token);
  downloadTokens.delete(token);
  if (!entry || entry.exp < nowSec() || entry.session.closed || !entry.session.sftp) {
    return sendJson(res, 404, { ok: false, error: 'expired' });
  }
  const session = entry.session;
  let real;
  try {
    real = await existingPath(session, entry.path);
    const st = await sftpCall(session.sftp, 'stat', real);
    const size = Number(st.size) || 0;
    if (size > config.sftp.max_bytes) return sendJson(res, 413, { ok: false, error: 'too_large' });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(real))}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    const stream = session.sftp.createReadStream(real);
    session.streams.add(stream);
    stream.on('close', () => session.streams.delete(stream));
    stream.on('error', () => { try { res.destroy(); } catch {} });
    pipeline(stream, res, () => { session.streams.delete(stream); });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 400, { ok: false, error: err.code || 'download_failed' });
    else res.destroy();
  }
}

async function handlePreview(req, res) {
  const session = sessionFromHeader(req);
  if (!session) return sendJson(res, 401, { ok: false, error: 'bad_session' });
  let target;
  try { target = decodeURIComponent(String(req.headers['x-marex-path'] || '')); } catch {
    return sendJson(res, 400, { ok: false, error: 'bad_path' });
  }
  const real = await existingPath(session, target);
  const st = await sftpCall(session.sftp, 'stat', real);
  const size = Number(st.size) || 0;
  if (size > config.sftp.preview_bytes) return sendJson(res, 413, { ok: false, error: 'too_large' });
  const kind = guessType(real);
  if (kind.kind === 'other') return sendJson(res, 415, { ok: false, error: 'unsupported' });
  const stream = session.sftp.createReadStream(real);
  session.streams.add(stream);
  const buf = await readAll(stream, config.sftp.preview_bytes).catch((err) => {
    session.streams.delete(stream);
    throw err;
  });
  session.streams.delete(stream);
  res.writeHead(200, {
    'Content-Type': kind.type,
    'Content-Length': buf.length,
    'Content-Disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent(path.posix.basename(real)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(buf);
}

// ---------- WebSocket session ----------
wss.on('connection', (ws, req) => {
  const login = loginOf(req);
  const ip = clientIp(req);
  const cookie = String(req.headers.cookie || '');
  const session = {
    ws, login, ip, cookie, device: null, closed: false,
    sshClient: null, sshStream: null, sftp: null, home: null, root: '/',
    rootAllowed: false, token: null, uploads: 0, streams: new Set(),
    timers: [], revalidate: null
  };
  let authed = false;
  let pendingError = null;
  let idleTimer = null;
  let maxTimer = null;

  audit('ssh_ws_open', { login, ip });

  const authTimer = setTimeout(() => {
    if (!authed) closeWithError(ws, 'auth_timeout', 'Ticket requis.');
  }, 5000);
  authTimer.unref();

  function cleanup(reason) {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(authTimer);
    clearInterval(idleTimer);
    clearTimeout(maxTimer);
    if (session.revalidate) clearInterval(session.revalidate);
    for (const stream of session.streams) { try { stream.destroy(); } catch {} }
    session.streams.clear();
    if (session.token) sftpSessions.delete(session.token);
    if (session.device) bump(sessionsByDevice, session.device, -1);
    bump(sessionsByLogin, login, -1);
    try { if (session.sshStream) session.sshStream.end(); } catch {}
    try { if (session.sftp) session.sftp.end(); } catch {}
    try { if (session.sshClient) session.sshClient.end(); } catch {}
    if (reason) audit('ssh_session_closed', { login, device: session.device, detail: reason });
  }

  function resetIdle() {
    if (!session.sshStream) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      closeWithError(ws, 'idle_timeout', 'Session inactive : déconnexion.');
      cleanup('idle_timeout');
    }, config.idle_timeout_min * 60 * 1000);
    idleTimer.unref();
  }

  function fail(code, message) {
    audit('ssh_error', { login, device: session.device, code });
    serverError(ws, code, message);
    cleanup(code);
    try { ws.close(1011, code); } catch {}
  }

  async function startSftp(client) {
    client.sftp(async (err, sftp) => {
      if (err) return;
      session.sftp = sftp;
      try {
        session.home = await sftpCall(sftp, 'realpath', '.');
      } catch {
        session.home = '/';
      }
      session.root = session.home;
      session.token = crypto.randomBytes(24).toString('base64url');
      sftpSessions.set(session.token, session);
      try {
        ws.send(JSON.stringify({
          type: 'sftp-ready',
          token: session.token,
          home: session.home,
          root: session.root,
          max_bytes: config.sftp.max_bytes,
          preview_bytes: config.sftp.preview_bytes
        }));
      } catch {}
    });
  }

  function connectSsh(msg) {
    const host = String(msg.host || '').trim();
    const port = Number(msg.port || 22);
    const username = String(msg.username || '').trim();
    const password = typeof msg.password === 'string' ? msg.password : '';
    const privateKey = typeof msg.privateKey === 'string' ? msg.privateKey : '';
    const passphrase = typeof msg.passphrase === 'string' ? msg.passphrase : '';
    let cols = Number(msg.cols) || 80;
    let rows = Number(msg.rows) || 24;
    cols = Math.max(20, Math.min(400, Math.floor(cols)));
    rows = Math.max(5, Math.min(200, Math.floor(rows)));

    if (!host || host.length > 255 || !/^[A-Za-z0-9._:-]+$/.test(host)) return fail('bad_host', 'Hôte invalide.');
    if (net.isIPv6(host) || host.includes(':')) return fail('bad_host', 'IPv6 non pris en charge.');
    if (!Number.isInteger(port) || !config.allowed_ports.includes(port)) return fail('bad_port', 'Port non autorisé (22 ou 2222).');
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) return fail('bad_user', "Nom d'utilisateur invalide.");
    if (!password && !privateKey) return fail('bad_credentials', 'Mot de passe ou clé SSH requis.');
    if (password.length > 512 || privateKey.length > 65536 || passphrase.length > 512) return fail('bad_credentials', 'Identifiants trop longs.');

    const hostId = host.toLowerCase() + ':' + port;

    (async () => {
      let addresses;
      try {
        addresses = net.isIPv4(host) ? [host] : (await dns.promises.lookup(host, { all: true, family: 4 })).map((r) => r.address);
      } catch {
        return fail('dns_error', 'Résolution DNS impossible.');
      }
      if (!addresses.length || !addresses.every(allowedIp)) {
        audit('ssh_denied_destination', { login, device: session.device, detail: host });
        return fail('destination_denied', 'Destination non autorisée.');
      }
      if ((sessionsByDevice.get(session.device) || 0) >= config.max_sessions ||
          (sessionsByLogin.get(login) || 0) >= config.max_sessions_per_login) {
        return fail('too_many_sessions', 'Trop de sessions ouvertes.');
      }
      bump(sessionsByDevice, session.device, 1);
      bump(sessionsByLogin, login, 1);

      const targetIp = addresses[0];
      const client = new Client();
      session.sshClient = client;
      let connected = false;

      client.on('ready', () => {
        connected = true;
        client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
          if (err) return fail('shell_error', 'Impossible d’ouvrir le shell.');
          session.sshStream = stream;
          audit('ssh_connected', { login, device: session.device, detail: `${hostId} (${targetIp})` });
          try {
            ws.send(JSON.stringify({ type: 'ready', host: hostId, fingerprint: knownHosts[hostId]?.fingerprint || null }));
          } catch {}

          resetIdle();
          maxTimer = setTimeout(() => {
            closeWithError(ws, 'max_session', 'Durée maximale de session atteinte.');
            cleanup('max_session');
          }, config.max_session_min * 60 * 1000);
          maxTimer.unref();

          stream.on('data', (data) => {
            resetIdle();
            if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
          });
          if (stream.stderr) {
            stream.stderr.on('data', (data) => {
              resetIdle();
              if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
            });
          }
          stream.on('close', (code) => {
            if (ws.readyState === ws.OPEN) {
              try { ws.send(JSON.stringify({ type: 'exit', code })); } catch {}
            }
            audit('ssh_closed', { login, device: session.device, detail: `${hostId};code=${code}` });
            cleanup('shell_exit');
            try { ws.close(1000, 'exit'); } catch {}
          });

          startSftp(client);
        });
      });

      client.on('error', (err) => {
        const info = pendingError || { code: 'ssh_error', message: err.message || 'Erreur SSH.' };
        if (!connected) audit('ssh_connect_failed', { login, device: session.device, detail: info.code });
        fail(info.code, info.message);
      });

      client.on('close', () => {
        if (!session.closed && !connected) fail('ssh_closed', 'Connexion SSH fermée.');
        else cleanup('ssh_closed');
      });

      client.connect({
        host: targetIp, port, username,
        password: password || undefined,
        privateKey: privateKey ? Buffer.from(privateKey) : undefined,
        passphrase: passphrase || undefined,
        readyTimeout: config.ready_timeout_sec * 1000,
        keepaliveInterval: 20000,
        keepaliveCountMax: 3,
        hostVerifier: (key) => {
          const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          const entry = knownHosts[hostId];
          if (!entry) {
            knownHosts[hostId] = { fingerprint, first_seen: nowSec(), last_seen: nowSec() };
            saveKnown();
            audit('ssh_hostkey_new', { login, device: session.device, detail: `${hostId};${fingerprint}` });
            return true;
          }
          if (entry.fingerprint !== fingerprint) {
            pendingError = {
              code: 'host_key_changed',
              message: `Clé d'hôte modifiée pour ${hostId}. Attendu ${entry.fingerprint}, reçu ${fingerprint}. Vérifiez puis « marexssh forget ${hostId} » sur PVE.`
            };
            audit('ssh_hostkey_mismatch', { login, device: session.device, detail: hostId });
            return false;
          }
          entry.last_seen = nowSec();
          saveKnown();
          return true;
        }
      });
    })();
  }

  async function handleSftpMessage(msg) {
    if (!session.sftp) return;
    try {
      if (msg.type === 'sftp-list') {
        const out = await listDir(session, String(msg.path || session.root));
        ws.send(JSON.stringify({ type: 'sftp-list', id: msg.id, ...out }));
        return;
      }
      if (msg.type === 'sftp-home') {
        session.root = session.home;
        ws.send(JSON.stringify({ type: 'sftp-root', id: msg.id, root: session.root, authorized: false }));
        return;
      }
      if (msg.type === 'sftp-authorize-root') {
        const payload = verifyTicket(msg.ticket);
        if (!payload || payload.sub !== session.device || payload.sftp_root !== true) {
          ws.send(JSON.stringify({ type: 'sftp-root', id: msg.id, root: session.root, authorized: false, error: 'root_denied' }));
          return;
        }
        session.root = '/';
        session.rootAllowed = true;
        audit('ssh_sftp_root_authorized', { login, device: session.device });
        ws.send(JSON.stringify({ type: 'sftp-root', id: msg.id, root: '/', authorized: true }));
        return;
      }
      if (msg.type === 'sftp-mkdir') {
        const real = await resolvePath(session, String(msg.path || ''));
        await sftpCall(session.sftp, 'mkdir', real);
        ws.send(JSON.stringify({ type: 'sftp-ok', id: msg.id, op: 'mkdir', path: real }));
        return;
      }
      if (msg.type === 'sftp-rename') {
        const from = await existingPath(session, String(msg.from || ''));
        const to = await resolvePath(session, String(msg.to || ''));
        try { await sftpCall(session.sftp, 'stat', to); throw Object.assign(new Error('exists'), { code: 'exists' }); } catch (e) { if (e.code === 'exists') throw e; }
        await sftpCall(session.sftp, 'rename', from, to);
        audit('ssh_sftp_rename', { login, device: session.device, detail: `${from}->${to}` });
        ws.send(JSON.stringify({ type: 'sftp-ok', id: msg.id, op: 'rename' }));
        return;
      }
      if (msg.type === 'sftp-copy') {
        const from = await existingPath(session, String(msg.from || ''));
        const to = await resolvePath(session, String(msg.to || ''));
        const st = await sftpCall(session.sftp, 'stat', from);
        if ((Number(st.size) || 0) > config.sftp.max_bytes) throw Object.assign(new Error('too_large'), { code: 'too_large' });
        try { await sftpCall(session.sftp, 'stat', to); throw Object.assign(new Error('exists'), { code: 'exists' }); } catch (e) { if (e.code === 'exists') throw e; }
        await new Promise((resolve, reject) => {
          pipeline(session.sftp.createReadStream(from), session.sftp.createWriteStream(to), (err) => err ? reject(err) : resolve());
        });
        audit('ssh_sftp_copy', { login, device: session.device, detail: `${from}->${to}` });
        ws.send(JSON.stringify({ type: 'sftp-ok', id: msg.id, op: 'copy' }));
        return;
      }
      if (msg.type === 'sftp-download') {
        const real = await existingPath(session, String(msg.path || ''));
        const st = await sftpCall(session.sftp, 'stat', real);
        if ((Number(st.size) || 0) > config.sftp.max_bytes) throw Object.assign(new Error('too_large'), { code: 'too_large' });
        const token = crypto.randomBytes(24).toString('base64url');
        downloadTokens.set(token, { session, path: real, exp: nowSec() + 60 });
        ws.send(JSON.stringify({ type: 'sftp-download-url', id: msg.id, url: '/ssh/sftp/download?t=' + token, name: path.posix.basename(real) }));
        return;
      }
    } catch (err) {
      try {
        ws.send(JSON.stringify({ type: 'sftp-error', id: msg.id, op: msg.type, error: err.code || 'sftp_error' }));
      } catch {}
    }
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'auth') {
      if (authed) return;
      const payload = verifyTicket(msg.ticket);
      if (!payload) {
        audit('ssh_ticket_rejected', { login, ip });
        return closeWithError(ws, 'bad_ticket', 'Ticket invalide ou expiré.');
      }
      authed = true;
      session.device = payload.sub;
      clearTimeout(authTimer);
      audit('ssh_ticket_ok', { login, device: session.device, ip });
      setTimeout(() => {
        if (!session.sshClient) closeWithError(ws, 'connect_timeout', 'Connexion SSH non demandée.');
      }, 60000).unref();
      try { ws.send(JSON.stringify({ type: 'authed' })); } catch {}
      if (cookie) {
        session.revalidate = setInterval(async () => {
          const state = await gateVerify(cookie);
          if (state === 'revoked') {
            audit('ssh_session_revoked', { login, device: session.device });
            closeWithError(ws, 'session_revoked', 'Session révoquée.');
            cleanup('revoked');
            try { ws.close(1008, 'revoked'); } catch {}
          }
        }, 30000);
        session.revalidate.unref();
      }
      return;
    }

    if (!authed) return closeWithError(ws, 'auth_required', 'Authentification requise.');

    if (msg.type === 'connect') {
      if (session.sshClient) return;
      return connectSsh(msg);
    }
    if (msg.type === 'input') {
      if (!session.sshStream) return;
      const text = typeof msg.data === 'string' ? msg.data : '';
      if (text.length > 16384) return;
      resetIdle();
      try { session.sshStream.write(text); } catch {}
      return;
    }
    if (msg.type === 'resize') {
      if (!session.sshStream) return;
      const cols = Math.max(20, Math.min(400, Math.floor(Number(msg.cols) || 80)));
      const rows = Math.max(5, Math.min(200, Math.floor(Number(msg.rows) || 24)));
      try { session.sshStream.setWindow(rows, cols, 0, 0); } catch {}
      return;
    }
    if (msg.type === 'disconnect') {
      audit('ssh_disconnect', { login, device: session.device });
      cleanup('disconnect');
      try { ws.close(1000, 'bye'); } catch {}
      return;
    }
    if (msg.type.startsWith('sftp-')) {
      handleSftpMessage(msg);
    }
  });

  ws.on('close', () => {
    cleanup('ws_close');
    audit('ssh_ws_closed', { login, device: session.device });
  });
  ws.on('error', () => cleanup('ws_error'));
});

server.listen(PORT, HOST, () => {
  console.log(`marexssh listening on ${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}
