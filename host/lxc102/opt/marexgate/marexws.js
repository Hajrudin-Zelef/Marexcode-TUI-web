'use strict';

// Proxy WebSocket/HTTP gate-aware devant ttyd.
// Chaque instance logique (1..4) écoute sur 127.0.0.1:769N et relaie vers
// ttyd sur 127.0.0.1:768N. Le cookie de session est validé auprès du gate au
// handshake puis revalidé périodiquement : une révocation ou une expiration
// ferme les sockets déjà ouvertes.

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');

const HOST = '127.0.0.1';
const GATE_PORT = 8789;
const REVALIDATE_MS = 10000;
const AUDIT_PATH = '/var/lib/marexgate/audit.jsonl';

const SLOTS = [
  { n: 1, listen: 7691, backend: 7681 },
  { n: 2, listen: 7692, backend: 7682 },
  { n: 3, listen: 7693, backend: 7683 },
  { n: 4, listen: 7694, backend: 7684 }
];

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection'
]);

function audit(event, detail) {
  const record = { ts: Math.floor(Date.now() / 1000), event, ip: null, device_id: null, detail };
  try {
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch {}
}

function verify(cookie) {
  return new Promise((resolve) => {
    const req = http.request({
      host: HOST,
      port: GATE_PORT,
      path: '/verify',
      method: 'GET',
      headers: { Cookie: cookie || '' },
      timeout: 4000
    }, (res) => {
      res.resume();
      resolve({
        ok: res.statusCode === 204,
        trustUntil: Number(res.headers['x-marex-trust-until'] || 0),
        device: res.headers['x-marex-device'] || null
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.on('error', () => resolve({ ok: false }));
    req.end();
  });
}

function filteredHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function unauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'WWW-Authenticate': 'Basic realm="Marexcode"'
  });
  res.end('Session requise.\n');
}

function makeServer(slot) {
  const prefix = `/terminal/${slot.n}/`;
  const activeSockets = new Set();

  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith(prefix)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found\n');
    }
    const cookie = req.headers.cookie || '';
    const check = await verify(cookie);
    if (!check.ok) return unauthorized(res);

    const upstream = http.request({
      host: HOST,
      port: slot.backend,
      method: req.method,
      path: req.url,
      headers: filteredHeaders(req.headers)
    }, (upRes) => {
      res.writeHead(upRes.statusCode, filteredHeaders(upRes.headers));
      upRes.pipe(res);
    });

    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Terminal indisponible.\n');
      } else {
        res.destroy();
      }
    });

    req.pipe(upstream);
  });

  server.on('upgrade', async (req, socket, head) => {
    if (!req.url.startsWith(prefix)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    const cookie = req.headers.cookie || '';
    const check = await verify(cookie);
    if (!check.ok) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);

    const upstream = net.connect(slot.backend, HOST, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i];
        const value = req.rawHeaders[i + 1];
        if (/^proxy-connection$/i.test(key)) continue;
        lines.push(`${key}: ${value}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });

    let closing = false;
    function closeBoth(reason) {
      if (closing) return;
      closing = true;
      clearInterval(interval);
      audit('terminal_ws_closed', `${reason};device=${check.device || '-'};slot=${slot.n}`);
      try {
        if (!socket.destroyed) {
          socket.write(Buffer.from([0x88, 0x02, 0x03, 0xf0]));
          socket.end();
        }
      } catch {}
      setTimeout(() => {
        try { socket.destroy(); } catch {}
        try { upstream.destroy(); } catch {}
      }, 300).unref();
      cleanup();
    }

    function cleanup() {
      clearInterval(interval);
      activeSockets.delete(socket);
      socket.removeListener('close', onClose);
    }

    function onClose() {
      closing = true;
      clearInterval(interval);
      activeSockets.delete(socket);
      try { upstream.destroy(); } catch {}
    }

    activeSockets.add(socket);
    socket.on('close', onClose);
    socket.on('error', onClose);
    upstream.on('error', () => closeBoth('upstream_error'));

    const interval = setInterval(async () => {
      const now = await verify(cookie);
      if (!now.ok) {
        closeBoth('revoked_or_expired');
        return;
      }
      if (now.trustUntil && now.trustUntil <= Math.floor(Date.now() / 1000)) {
        closeBoth('trust_expired');
      }
    }, REVALIDATE_MS);
    interval.unref();

    audit('terminal_ws_open', `device=${check.device || '-'};slot=${slot.n}`);

    socket.on('end', () => {
      try { upstream.end(); } catch {}
    });
  });

  server.on('error', (err) => {
    console.error(`marexws slot ${slot.n}: ${err.message}`);
  });

  server.listen(slot.listen, HOST, () => {
    console.log(`marexws slot ${slot.n}: ${HOST}:${slot.listen} -> ttyd ${slot.backend}`);
  });

  return { server, activeSockets };
}

const instances = SLOTS.map(makeServer);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const { server, activeSockets } of instances) {
      for (const socket of activeSockets) {
        try { socket.destroy(); } catch {}
      }
      server.close();
    }
    setTimeout(() => process.exit(0), 300);
  });
}
