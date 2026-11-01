'use strict';

const fs = require('node:fs');
const {
  openDb, initDb, getSetting, setSetting, nowSec, hashPassword,
  audit, generateTotpSecret, totpUri
} = require('./lib');

const db = openDb();
initDb(db);

const cmd = process.argv[2] || 'help';

function fmt(ts) {
  if (!ts) return '-';
  return new Date(Number(ts) * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}

async function main() {
  switch (cmd) {
    case 'passwd': {
      const password = readStdin();
      if (password.length < 12) {
        console.error('Mot de passe trop court (12 caractères minimum).');
        process.exit(1);
      }
      const hashed = await hashPassword(password);
      setSetting(db, 'master_hash', hashed);
      db.prepare('UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL').run(nowSec());
      audit('master_changed', { ip: 'cli', detail: 'sessions_revoked' });
      console.log('Mot de passe maître défini. Toutes les sessions/appareils ont été révoqués.');
      return;
    }
    case 'status': {
      const configured = Boolean(getSetting(db, 'master_hash'));
      const count = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL').get().n;
      console.log(`maître configuré : ${configured ? 'oui' : 'non'}`);
      console.log(`TOTP             : ${getSetting(db, 'totp_enabled') === '1' ? 'activé' : 'désactivé'}`);
      console.log(`confiance        : ${getSetting(db, 'trust_days')} j (max ${getSetting(db, 'max_trust_days')} j)`);
      console.log(`appareils actifs : ${count}`);
      return;
    }
    case 'devices': {
      const rows = db.prepare('SELECT * FROM devices ORDER BY created_at DESC').all();
      if (!rows.length) {
        console.log('Aucun appareil.');
        return;
      }
      for (const row of rows) {
        console.log([
          row.id,
          row.name,
          `créé=${fmt(row.created_at)}`,
          `vu=${fmt(row.last_seen_at)}`,
          `confiance=${fmt(row.trust_until)}`,
          row.revoked_at ? `révoqué=${fmt(row.revoked_at)}` : 'actif'
        ].join('  '));
      }
      return;
    }
    case 'revoke': {
      const id = process.argv[3];
      if (!id) {
        console.error('Usage : marexgate revoke <id|all>');
        process.exit(1);
      }
      const t = nowSec();
      if (id === 'all') {
        const res = db.prepare('UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL').run(t);
        audit('devices_revoked_all', { ip: 'cli', detail: `count:${res.changes}` });
        console.log(`Appareils révoqués : ${res.changes}`);
      } else {
        const target = db.prepare('SELECT id FROM devices WHERE id = ? AND revoked_at IS NULL').get(id);
        if (!target) {
          console.error('Appareil inconnu ou déjà révoqué.');
          process.exit(1);
        }
        db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(t, id);
        audit('device_revoked', { ip: 'cli', deviceId: id });
        console.log(`Appareil révoqué : ${id}`);
      }
      return;
    }
    case 'ttl': {
      const value = Number(process.argv[3]);
      const max = Number(getSetting(db, 'max_trust_days')) || 90;
      if (!Number.isInteger(value) || value < 0 || value > max) {
        console.error(`Durée invalide (0 à ${max} jours).`);
        process.exit(1);
      }
      setSetting(db, 'trust_days', value);
      audit('ttl_changed', { ip: 'cli', detail: `days:${value}` });
      console.log(`Durée de confiance par défaut : ${value} j (max ${max} j).`);
      return;
    }
    case 'totp-setup': {
      const secret = generateTotpSecret();
      setSetting(db, 'totp_secret', secret);
      setSetting(db, 'totp_enabled', '1');
      audit('totp_enabled', { ip: 'cli' });
      console.log('TOTP activé. Secret (affiché une seule fois) :');
      console.log(`  ${secret}`);
      console.log('URI :');
      console.log(`  ${totpUri(secret)}`);
      return;
    }
    case 'totp-disable': {
      setSetting(db, 'totp_enabled', '0');
      db.prepare("DELETE FROM settings WHERE key = 'totp_secret'").run();
      audit('totp_disabled', { ip: 'cli' });
      console.log('TOTP désactivé.');
      return;
    }
    case 'passkeys': {
      const rows = db.prepare('SELECT id, name, rp_id, created_at, last_used_at FROM webauthn_credentials ORDER BY created_at DESC').all();
      if (!rows.length) {
        console.log('Aucune passkey.');
        return;
      }
      for (const row of rows) {
        console.log([
          row.id,
          row.name,
          row.rp_id,
          `créée=${fmt(row.created_at)}`,
          row.last_used_at ? `utilisée=${fmt(row.last_used_at)}` : 'jamais utilisée'
        ].join('  '));
      }
      return;
    }
    case 'passkeys-clear': {
      const res = db.prepare('DELETE FROM webauthn_credentials').run();
      audit('passkeys_cleared', { ip: 'cli', detail: `count:${res.changes}` });
      console.log(`Passkeys supprimées : ${res.changes}`);
      return;
    }
    case 'panic': {
      const t = nowSec();
      const dev = db.prepare('UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL').run(t);
      const pk = db.prepare('DELETE FROM webauthn_credentials').run();
      audit('panic', { ip: 'cli', detail: `devices:${dev.changes};passkeys:${pk.changes}` });
      console.log(`PANIC : ${dev.changes} appareil(s) révoqué(s), ${pk.changes} passkey(s) supprimée(s).`);
      console.log('Définissez un nouveau maître : sudo marexgate passwd');
      return;
    }
    case 'reset': {
      db.prepare("DELETE FROM settings WHERE key IN ('master_hash','totp_secret','totp_enabled')").run();
      db.prepare('UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL').run(nowSec());
      db.prepare('DELETE FROM webauthn_credentials').run();
      audit('master_reset', { ip: 'cli', detail: 'devices_revoked;passkeys_cleared' });
      console.log('Maître réinitialisé (non configuré). Sessions/appareils révoqués, passkeys supprimées.');
      return;
    }
    default:
      console.log(`Usage : marexgate <commande>

  passwd            définir le mot de passe maître (interactif)
  status            état du gate
  devices           lister les appareils
  revoke <id|all>   révoquer un appareil ou tous
  ttl <jours>       durée de confiance par défaut (0..max)
  totp-setup        activer TOTP et afficher le secret
  totp-disable      désactiver TOTP
  passkeys          lister les passkeys
  passkeys-clear    supprimer toutes les passkeys
  panic             révoquer tous les appareils + supprimer les passkeys
  reset             effacer le maître, révoquer les appareils, supprimer les passkeys
`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
