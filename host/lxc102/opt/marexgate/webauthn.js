'use strict';

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

const { nowSec, randomToken, getSetting, setSetting, safeEqual } = require('./lib');

const REG_TTL_MS = 3 * 60 * 1000;
const AUTH_TTL_MS = 3 * 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_MAX = 20;

const b64u = (u8) => Buffer.from(u8).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

function cleanName(value, fallback) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  return name || fallback;
}

module.exports = function createWebAuthn(ctx) {
  const {
    db, config, audit, notify, clientIp, sendJson, readJson,
    createDevice, validStepUp, cookieHeader, authDevice
  } = ctx;

  const regChallenges = new Map();
  const authChallenges = new Map();
  const fails = new Map();

  function hostOf(req) {
    return String(req.headers.host || '').split(':')[0].toLowerCase();
  }

  function rpFor(req) {
    const origins = (config.webauthn && config.webauthn.origins) || {};
    const rp = origins[hostOf(req)];
    return rp && rp.rp_id && rp.origin ? rp : null;
  }

  function userHandle() {
    let id = getSetting(db, 'webauthn_user_id');
    if (!id) {
      id = randomToken(24);
      setSetting(db, 'webauthn_user_id', id);
    }
    return id;
  }

  function prune() {
    const now = Date.now();
    for (const [key, entry] of regChallenges) if (entry.exp <= now) regChallenges.delete(key);
    for (const [key, entry] of authChallenges) if (entry.exp <= now) authChallenges.delete(key);
    for (const [key, entry] of fails) if (entry.until <= now) fails.delete(key);
  }

  function blocked(ip) {
    const entry = fails.get(ip);
    return entry && entry.until > Date.now();
  }

  function fail(ip) {
    const entry = fails.get(ip) || { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= FAIL_MAX) entry.until = Date.now() + FAIL_WINDOW_MS;
    fails.set(ip, entry);
  }

  function requireDeviceWithCsrf(req, res) {
    const device = authDevice(req);
    if (!device) { sendJson(res, 401, { ok: false, error: 'locked' }); return null; }
    if (!safeEqual(String(req.headers['x-csrf'] || ''), device.csrf_secret)) {
      sendJson(res, 403, { ok: false, error: 'bad_csrf' });
      return null;
    }
    return device;
  }

  async function registerOptions(req, res) {
    const device = requireDeviceWithCsrf(req, res);
    if (!device) return;
    const rp = rpFor(req);
    if (!rp) return sendJson(res, 400, { ok: false, error: 'rp_not_allowed' });

    prune();
    const existing = db.prepare(
      'SELECT credential_id, transports FROM webauthn_credentials WHERE rp_id = ?'
    ).all(rp.rp_id);

    const options = await generateRegistrationOptions({
      rpName: (config.webauthn && config.webauthn.rp_name) || 'Marexcode',
      rpID: rp.rp_id,
      userID: new Uint8Array(unb64u(userHandle())),
      userName: 'marex',
      userDisplayName: 'Marexcode',
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credential_id,
        transports: JSON.parse(c.transports || '[]')
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred'
      }
    });

    regChallenges.set(device.id, {
      challenge: options.challenge,
      rpID: rp.rp_id,
      origin: rp.origin,
      exp: Date.now() + REG_TTL_MS
    });
    return sendJson(res, 200, options);
  }

  async function registerVerify(req, res) {
    const device = requireDeviceWithCsrf(req, res);
    if (!device) return;

    const pending = regChallenges.get(device.id);
    if (!pending || pending.exp <= Date.now()) {
      regChallenges.delete(device.id);
      return sendJson(res, 400, { ok: false, error: 'no_pending_registration' });
    }

    let body;
    try { body = await readJson(req); } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message || 'bad_request' });
    }
    const response = body.credential;
    if (!response || !response.id || !response.response) {
      return sendJson(res, 400, { ok: false, error: 'bad_credential' });
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpID,
        requireUserVerification: false
      });
    } catch (err) {
      regChallenges.delete(device.id);
      audit('webauthn_register_failed', { ip: clientIp(req), deviceId: device.id, detail: err.message });
      return sendJson(res, 400, { ok: false, error: 'verification_failed' });
    }
    regChallenges.delete(device.id);

    if (!verification.verified || !verification.registrationInfo) {
      audit('webauthn_register_failed', { ip: clientIp(req), deviceId: device.id, detail: 'not_verified' });
      return sendJson(res, 400, { ok: false, error: 'verification_failed' });
    }

    const { credential } = verification.registrationInfo;
    const id = randomToken(16);
    const name = cleanName(body.name, 'Passkey');

    db.prepare(`INSERT INTO webauthn_credentials
      (id, device_id, credential_id, public_key, counter, transports, rp_id, name, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(id, device.id, credential.id, b64u(credential.publicKey), credential.counter,
        JSON.stringify(credential.transports || []), pending.rpID, name, nowSec());

    audit('webauthn_registered', { ip: clientIp(req), deviceId: device.id, detail: `${pending.rpID}:${name}` });
    notify(`Passkey ajoutée (${pending.rpID})`);
    return sendJson(res, 200, { ok: true, id, name, rp_id: pending.rpID });
  }

  async function loginOptions(req, res) {
    const rp = rpFor(req);
    if (!rp) return sendJson(res, 400, { ok: false, error: 'rp_not_allowed' });

    prune();
    const creds = db.prepare(
      'SELECT credential_id, transports FROM webauthn_credentials WHERE rp_id = ?'
    ).all(rp.rp_id);
    if (!creds.length) return sendJson(res, 404, { ok: false, error: 'no_passkey' });

    const options = await generateAuthenticationOptions({
      rpID: rp.rp_id,
      allowCredentials: creds.map((c) => ({
        id: c.credential_id,
        transports: JSON.parse(c.transports || '[]')
      })),
      userVerification: 'preferred'
    });

    authChallenges.set(options.challenge, {
      exp: Date.now() + AUTH_TTL_MS,
      rpID: rp.rp_id,
      origin: rp.origin
    });
    return sendJson(res, 200, options);
  }

  async function loginVerify(req, res) {
    const ip = clientIp(req);
    if (blocked(ip)) {
      const retry = Math.max(1, Math.ceil((fails.get(ip).until - Date.now()) / 1000));
      return sendJson(res, 429, { ok: false, error: 'rate_limited', retry_after: retry });
    }

    let body;
    try { body = await readJson(req); } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message || 'bad_request' });
    }
    const response = body.credential;
    if (!response || !response.id || !response.response || !response.response.clientDataJSON) {
      return sendJson(res, 400, { ok: false, error: 'bad_credential' });
    }

    let challenge;
    try {
      const clientData = JSON.parse(unb64u(response.response.clientDataJSON).toString('utf8'));
      challenge = clientData.challenge;
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad_credential' });
    }

    const pending = challenge ? authChallenges.get(challenge) : null;
    if (!pending || pending.exp <= Date.now()) {
      fail(ip);
      audit('webauthn_login_failed', { ip, detail: 'expired_challenge' });
      return sendJson(res, 400, { ok: false, error: 'expired_challenge' });
    }

    const row = db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?')
      .get(String(response.id));
    if (!row || row.rp_id !== pending.rpID) {
      authChallenges.delete(challenge);
      fail(ip);
      audit('webauthn_login_failed', { ip, detail: 'unknown_credential' });
      return sendJson(res, 401, { ok: false, error: 'invalid_passkey' });
    }
    authChallenges.delete(challenge);

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpID,
        credential: {
          id: row.credential_id,
          publicKey: unb64u(row.public_key),
          counter: row.counter,
          transports: JSON.parse(row.transports || '[]')
        },
        requireUserVerification: false
      });
    } catch (err) {
      fail(ip);
      audit('webauthn_login_failed', { ip, detail: err.message });
      return sendJson(res, 401, { ok: false, error: 'invalid_passkey' });
    }

    if (!verification.verified) {
      fail(ip);
      audit('webauthn_login_failed', { ip, detail: 'not_verified' });
      return sendJson(res, 401, { ok: false, error: 'invalid_passkey' });
    }

    const info = verification.authenticationInfo;
    db.prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(info.newCounter, nowSec(), row.id);
    fails.delete(ip);

    const maxDays = Number(getSetting(db, 'max_trust_days')) || 90;
    let days = body.trust_days === undefined
      ? Number(getSetting(db, 'trust_days')) || 30
      : Number(body.trust_days);
    if (!Number.isFinite(days)) days = 0;
    days = Math.max(0, Math.min(Math.floor(days), maxDays));

    const name = cleanName(body.device_name, 'Passkey');
    const device = createDevice(req, res, { name, days });
    audit('webauthn_login_success', { ip, deviceId: device.id, detail: pending.rpID });

    return sendJson(res, 200, {
      ok: true,
      locked: false,
      device: { id: device.id, name: device.name },
      trust_until: device.trustUntil,
      trust_days: days,
      csrf: device.csrf,
      totp_enabled: getSetting(db, 'totp_enabled') === '1',
      webauthn: true
    }, { 'Set-Cookie': cookieHeader(device.token, days > 0 ? days * 86400 : undefined) });
  }

  function listCredentials(req, res) {
    const device = authDevice(req);
    if (!device) return sendJson(res, 401, { ok: false, error: 'locked' });
    const rows = db.prepare(
      'SELECT id, name, rp_id, created_at, last_used_at FROM webauthn_credentials ORDER BY created_at DESC'
    ).all();
    return sendJson(res, 200, {
      ok: true,
      credentials: rows,
      supported_hosts: Object.keys((config.webauthn && config.webauthn.origins) || {}),
      current_rp: rpFor(req) ? rpFor(req).rp_id : null
    });
  }

  function deleteCredential(req, res, id) {
    const device = requireDeviceWithCsrf(req, res);
    if (!device) return;
    if (!validStepUp(device.id, String(req.headers['x-step-up'] || ''))) {
      return sendJson(res, 403, { ok: false, error: 'step_up_required' });
    }
    const row = db.prepare('SELECT id, name, rp_id FROM webauthn_credentials WHERE id = ?').get(id);
    if (!row) return sendJson(res, 404, { ok: false, error: 'unknown_passkey' });
    db.prepare('DELETE FROM webauthn_credentials WHERE id = ?').run(id);
    audit('webauthn_deleted', { ip: clientIp(req), deviceId: device.id, detail: `${row.rp_id}:${row.name}` });
    notify(`Passkey supprimée (${row.rp_id})`);
    return sendJson(res, 200, { ok: true });
  }

  return {
    registerOptions,
    registerVerify,
    loginOptions,
    loginVerify,
    listCredentials,
    deleteCredential
  };
};
