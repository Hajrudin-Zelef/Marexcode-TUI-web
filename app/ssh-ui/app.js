'use strict';

(function () {
  document.body.classList.toggle('embedded', window.parent !== window);
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const connectLayer = $('connectLayer');
  const hostEl = $('host');
  const portEl = $('port');
  const userEl = $('user');
  const authEl = $('auth');
  const keyEl = $('key');
  const passEl = $('pass');
  const passphraseEl = $('passphrase');
  const keyRow = $('keyRow');
  const passRow = $('passRow');
  const statusEl = $('status');
  const termEl = $('term');
  const goEl = $('go');
  const tabsEl = $('tabs');
  const tabTerm = $('tabTerm');
  const tabFiles = $('tabFiles');
  const connInfo = $('connInfo');
  const disconnectBtn = $('disconnect');
  const sftpEl = $('sftp');
  const sfPath = $('sfPath');
  const sfMsg = $('sfMsg');
  const sfList = $('sfList');
  const sfPreview = $('sfPreview');
  const sfPreviewName = $('sfPreviewName');
  const sfPreviewText = $('sfPreviewText');
  const sfPreviewImg = $('sfPreviewImg');
  const sfPreviewDl = $('sfPreviewDl');

  let ws = null;
  let term = null;
  let fit = null;
  let connected = false;
  let ticket = null;
  let pendingTicket = null;
  let pendingRoot = null;
  let rpcSeq = 0;
  const rpc = new Map();
  const sftp = { ready: false, token: null, home: null, root: null, path: null, authorized: false, loaded: false };

  function status(text, cls) {
    statusEl.textContent = text || '';
    statusEl.className = cls || '';
  }
  function sfStatus(text, cls) {
    sfMsg.textContent = text || '';
    sfMsg.className = 'note ' + (cls || '');
  }

  function setAuthMode() {
    const key = authEl.value === 'key';
    keyRow.classList.toggle('hidden', !key);
    passphraseEl.parentElement.classList.toggle('hidden', !key);
    passRow.classList.toggle('hidden', key);
  }
  authEl.addEventListener('change', setAuthMode);
  setAuthMode();

  function postToParent(message) {
    try { window.parent.postMessage(message, window.location.origin); } catch {}
  }

  function requestTicket() {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    pendingTicket = id;
    status('Demande de ticket…');
    postToParent({ type: 'marexssh-ticket-request', id });
    setTimeout(() => {
      if (pendingTicket === id) {
        pendingTicket = null;
        status('Le portail n’a pas répondu. Rechargez la page.', 'err');
        goEl.disabled = false;
      }
    }, 8000);
  }

  function mapError(code, message) {
    if (message) return message;
    switch (code) {
      case 'bad_ticket': return 'Ticket invalide ou expiré — réessayez.';
      case 'auth_timeout': return 'Authentification expirée.';
      case 'destination_denied': return 'Destination non autorisée (tailnet, 10.0.0.0/24, 192.168.1.0/24).';
      case 'bad_port': return 'Port non autorisé (22 ou 2222).';
      case 'bad_host': return 'Hôte invalide.';
      case 'bad_user': return 'Nom d’utilisateur invalide.';
      case 'bad_credentials': return 'Mot de passe ou clé SSH requis.';
      case 'dns_error': return 'Résolution DNS impossible.';
      case 'too_many_sessions': return 'Trop de sessions ouvertes.';
      case 'idle_timeout': return 'Session inactive : déconnectée.';
      case 'max_session': return 'Durée maximale de session atteinte.';
      case 'session_revoked': return 'Session révoquée (appareil révoqué ou expiré).';
      case 'host_key_changed': return message || 'Clé d’hôte modifiée — connexion bloquée.';
      case 'ssh_error': return 'Échec SSH : identifiants refusés ou serveur injoignable.';
      case 'too_large': return 'Fichier trop volumineux.';
      case 'outside_root': return 'Chemin hors de la racine autorisée.';
      case 'exists': return 'Le fichier existe déjà.';
      default: return 'Erreur : ' + (code || 'inconnue');
    }
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function callSftp(obj, timeout = 20000) {
    const id = 'r' + (++rpcSeq);
    return new Promise((resolve) => {
      rpc.set(id, resolve);
      send({ ...obj, id });
      setTimeout(() => {
        if (rpc.has(id)) { rpc.delete(id); resolve({ type: 'timeout' }); }
      }, timeout);
    });
  }

  function resize() {
    if (!fit || !term || !termEl.classList.contains('on')) return;
    try { fit.fit(); } catch {}
    send({ type: 'resize', cols: term.cols, rows: term.rows });
  }

  function showTerminal() {
    tabTerm.classList.add('active');
    tabFiles.classList.remove('active');
    termEl.classList.add('on');
    sftpEl.classList.remove('on');
    if (!term) {
      term = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        scrollback: 5000,
        theme: { background: '#000000', foreground: '#e6edf3' }
      });
      fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(termEl);
      term.onData((data) => send({ type: 'input', data }));
      new ResizeObserver(() => resize()).observe(termEl);
    }
    setTimeout(() => { resize(); term.focus(); }, 60);
  }

  function showFiles() {
    tabFiles.classList.add('active');
    tabTerm.classList.remove('active');
    sftpEl.classList.add('on');
    termEl.classList.remove('on');
    if (!sftp.ready) {
      sfStatus('Initialisation SFTP…');
      return;
    }
    if (!sftp.loaded) refreshList();
  }

  function resetSession(message, cls) {
    connected = false;
    sftp.ready = false;
    sftp.loaded = false;
    sftp.token = null;
    sftp.home = null;
    sftp.root = null;
    sftp.path = null;
    sftp.authorized = false;
    rpc.clear();
    tabsEl.classList.add('hidden');
    sftpEl.classList.remove('on');
    termEl.classList.remove('on');
    form.classList.remove('hidden');
    connectLayer.classList.remove('hidden');
    goEl.disabled = false;
    sfPreview.classList.add('hidden');
    sfList.innerHTML = '';
    sfPath.value = '';
    updateRootBtn();
    status(message || '', cls);
  }

  function disconnect(silent) {
    send({ type: 'disconnect' });
    if (ws) { try { ws.close(); } catch {} ws = null; }
    if (!silent) resetSession('Déconnecté.', '');
  }

  function updateRootBtn() {
    $('sfRoot').textContent = sftp.authorized ? 'Revenir au home' : 'Afficher la racine';
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' o';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' Ko';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' Mo';
    return (n / 1073741824).toFixed(2) + ' Go';
  }
  function fmtDate(ts) {
    return ts ? new Date(Number(ts) * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
  }
  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function joinPath(dir, name) {
    if (dir === '/') return '/' + name;
    return dir.replace(/\/+$/, '') + '/' + name;
  }
  function parentPath(p) {
    if (!p || p === '/') return '/';
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }

  async function refreshList(path) {
    if (!sftp.ready) return;
    const target = path || sftp.path || sftp.root;
    const r = await callSftp({ type: 'sftp-list', path: target });
    if (r.type === 'timeout') { sfStatus('Délai dépassé.', 'err'); return; }
    if (r.type === 'sftp-error') {
      sfStatus(mapError(r.error), 'err');
      return;
    }
    sftp.loaded = true;
    sftp.path = r.path || target;
    sfPath.value = sftp.path;
    sfPreview.classList.add('hidden');
    renderList(r.entries || []);
    sfStatus(r.truncated ? 'Liste tronquée (2000 entrées).' : '', '');
  }

  function renderList(entries) {
    if (!entries.length) {
      sfList.innerHTML = '<div class="note" style="padding:12px">Dossier vide.</div>';
      return;
    }
    sfList.innerHTML = entries.map((e) => {
      const isDir = e.type === 'd';
      const isLink = e.type === 'l';
      const icon = isDir ? '▸' : isLink ? '↪' : '·';
      const actions = isDir ? '' : `
        <button data-act="dl" title="Télécharger">⇩</button>
        <button data-act="dup" title="Dupliquer">⧉</button>`;
      return `<div class="sf-row ${isDir ? 'dir' : ''}" data-name="${esc(e.name)}" data-etype="${esc(e.type)}">
        <span class="sf-ic">${icon}</span>
        <span class="sf-name ${isDir ? 'dir' : ''}">${esc(e.name)}${isLink ? ' <span class="note">(lien)</span>' : ''}</span>
        <span class="sf-size">${isDir ? '-' : fmtSize(e.size)}</span>
        <span class="sf-date">${fmtDate(e.mtime)}</span>
        <span class="sf-actions">
          <button data-act="ren" title="Renommer">✎</button>
          ${actions}
        </span>
      </div>`;
    }).join('');
  }

  async function previewFile(name) {
    const target = joinPath(sftp.path, name);
    sfStatus('Chargement…');
    try {
      const r = await fetch('/ssh/sftp/preview', {
        credentials: 'same-origin',
        headers: { 'X-Marex-Sftp': sftp.token, 'X-Marex-Path': encodeURIComponent(target) }
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        sfStatus(mapError(j.error || ('HTTP ' + r.status)), 'err');
        return;
      }
      const type = r.headers.get('content-type') || '';
      sfPreviewName.textContent = target;
      sfPreview.classList.remove('hidden');
      sfPreviewText.textContent = '';
      sfPreviewImg.classList.add('hidden');
      sfPreviewImg.removeAttribute('src');
      if (type.startsWith('image/')) {
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        sfPreviewImg.src = url;
        sfPreviewImg.classList.remove('hidden');
      } else {
        const text = await r.text();
        sfPreviewText.textContent = text;
      }
      sfStatus('');
      const dl = await callSftp({ type: 'sftp-download', path: target });
      if (dl.url) sfPreviewDl.href = dl.url;
    } catch (_) {
      sfStatus('Aperçu impossible.', 'err');
    }
  }

  async function renameEntry(name) {
    const next = prompt('Nouveau nom :', name);
    if (!next || next === name) return;
    if (next.includes('/')) { sfStatus('Nom invalide.', 'err'); return; }
    const from = joinPath(sftp.path, name);
    const to = joinPath(sftp.path, next);
    const r = await callSftp({ type: 'sftp-rename', from, to });
    if (r.type === 'sftp-ok') { sfStatus('Renommé.'); refreshList(); }
    else sfStatus(mapError(r.error || r.type), 'err');
  }

  async function duplicateEntry(name) {
    const dot = name.lastIndexOf('.');
    const suggested = dot > 0 ? name.slice(0, dot) + ' (copie)' + name.slice(dot) : name + ' (copie)';
    const next = prompt('Nom de la copie :', suggested);
    if (!next || next === name) return;
    if (next.includes('/')) { sfStatus('Nom invalide.', 'err'); return; }
    const from = joinPath(sftp.path, name);
    const to = joinPath(sftp.path, next);
    const r = await callSftp({ type: 'sftp-copy', from, to });
    if (r.type === 'sftp-ok') { sfStatus('Copie créée.'); refreshList(); }
    else sfStatus(mapError(r.error || r.type), 'err');
  }

  async function downloadEntry(name) {
    const target = joinPath(sftp.path, name);
    const r = await callSftp({ type: 'sftp-download', path: target });
    if (!r.url) { sfStatus(mapError(r.error || r.type), 'err'); return; }
    const a = document.createElement('a');
    a.href = r.url;
    a.download = r.name || name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function uploadFile(file) {
    const target = joinPath(sftp.path, file.name);
    const headers = { 'X-Marex-Sftp': sftp.token, 'X-Marex-Path': encodeURIComponent(target) };
    let r = await fetch('/ssh/sftp/upload', { method: 'POST', credentials: 'same-origin', headers, body: file });
    if (r.status === 409) {
      if (!confirm('« ' + file.name + ' » existe déjà. Écraser ?')) {
        sfStatus('Import annulé.', 'warn');
        return;
      }
      r = await fetch('/ssh/sftp/upload', {
        method: 'POST', credentials: 'same-origin',
        headers: { ...headers, 'X-Marex-Overwrite': '1' }, body: file
      });
    }
    if (r.ok) sfStatus('Importé : ' + file.name, 'ok');
    else {
      const j = await r.json().catch(() => ({}));
      sfStatus('Échec import ' + file.name + ' (' + (j.error || r.status) + ').', 'err');
    }
  }

  async function uploadFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    for (const file of list) await uploadFile(file);
    refreshList();
  }

  async function makeDir() {
    const name = prompt('Nom du nouveau dossier :');
    if (!name) return;
    if (name.includes('/')) { sfStatus('Nom invalide.', 'err'); return; }
    const r = await callSftp({ type: 'sftp-mkdir', path: joinPath(sftp.path, name) });
    if (r.type === 'sftp-ok') { sfStatus('Dossier créé.'); refreshList(); }
    else sfStatus(mapError(r.error || r.type), 'err');
  }

  async function toggleRoot() {
    if (!sftp.ready) return;
    if (sftp.authorized) {
      const r = await callSftp({ type: 'sftp-home' });
      if (r.type === 'sftp-root') {
        sftp.authorized = false;
        sftp.root = r.root;
        sftp.path = r.root;
        updateRootBtn();
        refreshList();
      }
      return;
    }
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    pendingRoot = id;
    sfStatus('Confirmation du mot de passe maître…', 'warn');
    postToParent({ type: 'marexssh-root-ticket-request', id });
    setTimeout(() => {
      if (pendingRoot === id) { pendingRoot = null; sfStatus('Confirmation expirée.', 'err'); }
    }, 120000);
  }

  async function authorizeRoot(ticketValue) {
    const r = await callSftp({ type: 'sftp-authorize-root', ticket: ticketValue });
    if (r.type === 'sftp-root' && r.authorized) {
      sftp.authorized = true;
      sftp.root = r.root;
      sftp.path = r.root;
      updateRootBtn();
      sfStatus('Racine autorisée (step-up).', 'warn');
      refreshList();
    } else {
      sfStatus('Racine refusée.', 'err');
    }
  }

  sfList.addEventListener('click', (ev) => {
    const actBtn = ev.target.closest('[data-act]');
    const row = ev.target.closest('.sf-row');
    if (!row) return;
    const name = row.getAttribute('data-name');
    const type = row.getAttribute('data-etype');
    if (actBtn) {
      const act = actBtn.getAttribute('data-act');
      if (act === 'dl') downloadEntry(name);
      else if (act === 'ren') renameEntry(name);
      else if (act === 'dup') duplicateEntry(name);
      return;
    }
    if (type === 'd') refreshList(joinPath(sftp.path, name));
    else previewFile(name);
  });

  sfList.addEventListener('dragover', (ev) => { ev.preventDefault(); sfList.classList.add('drop'); });
  sfList.addEventListener('dragleave', () => sfList.classList.remove('drop'));
  sfList.addEventListener('drop', (ev) => {
    ev.preventDefault();
    sfList.classList.remove('drop');
    if (!sftp.ready) return;
    uploadFiles(ev.dataTransfer.files);
  });

  $('sfRefresh').addEventListener('click', () => refreshList());
  $('sfUp').addEventListener('click', () => refreshList(parentPath(sftp.path)));
  $('sfHome').addEventListener('click', () => { sftp.path = sftp.root; refreshList(); });
  $('sfRoot').addEventListener('click', toggleRoot);
  $('sfMkdir').addEventListener('click', makeDir);
  $('sfUpload').addEventListener('change', (ev) => { uploadFiles(ev.target.files); ev.target.value = ''; });
  $('sfPreviewClose').addEventListener('click', () => sfPreview.classList.add('hidden'));
  tabTerm.addEventListener('click', showTerminal);
  tabFiles.addEventListener('click', showFiles);
  disconnectBtn.addEventListener('click', () => disconnect(false));

  function finishConnect(url) {
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => send({ type: 'auth', ticket });
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        if (term) term.write(new Uint8Array(ev.data));
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && rpc.has(msg.id)) {
        const resolve = rpc.get(msg.id);
        rpc.delete(msg.id);
        resolve(msg);
        return;
      }
      if (msg.type === 'authed') {
        const useKey = authEl.value === 'key';
        send({
          type: 'connect',
          host: hostEl.value.trim(),
          port: Number(portEl.value) || 22,
          username: userEl.value.trim(),
          password: useKey ? undefined : passEl.value,
          privateKey: useKey ? keyEl.value : undefined,
          passphrase: useKey ? passphraseEl.value : undefined,
          cols: term ? term.cols : 80,
          rows: term ? term.rows : 24
        });
        passEl.value = '';
        keyEl.value = '';
        passphraseEl.value = '';
      } else if (msg.type === 'ready') {
        connected = true;
        connInfo.textContent = msg.host + (msg.fingerprint ? ' · ' + msg.fingerprint : '');
        form.classList.add('hidden');
        connectLayer.classList.add('hidden');
        tabsEl.classList.remove('hidden');
        showTerminal();
      } else if (msg.type === 'sftp-ready') {
        sftp.ready = true;
        sftp.token = msg.token;
        sftp.home = msg.home;
        sftp.root = msg.home;
        sftp.path = msg.home;
        sftp.authorized = false;
        updateRootBtn();
        if (tabFiles.classList.contains('active')) refreshList();
      } else if (msg.type === 'error') {
        status(mapError(msg.code, msg.message), 'err');
        if (msg.code === 'bad_ticket') postToParent({ type: 'marexssh-locked' });
        if (!connected) resetSession(mapError(msg.code, msg.message), 'err');
      } else if (msg.type === 'exit') {
        status('Session terminée (code ' + msg.code + ').');
        setTimeout(() => resetSession('Session terminée.', ''), 400);
      }
    };
    ws.onclose = () => {
      if (connected) resetSession('Déconnecté.', '');
      ws = null;
    };
    ws.onerror = () => {
      if (!connected) resetSession('Connexion WebSocket impossible.', 'err');
    };
  }

  window.addEventListener('message', (ev) => {
    if (ev.origin !== window.location.origin) return;
    if (ev.source !== window.parent) return;
    const data = ev.data || {};
    if (data.type === 'marexssh-ticket') {
      if (!pendingTicket || data.id !== pendingTicket) return;
      pendingTicket = null;
      ticket = data.ticket;
      if (!ticket) { status('Ticket manquant.', 'err'); goEl.disabled = false; return; }
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      finishConnect(proto + '://' + window.location.host + '/ssh/ws');
    } else if (data.type === 'marexssh-ticket-error') {
      if (!pendingTicket || data.id !== pendingTicket) return;
      pendingTicket = null;
      goEl.disabled = false;
      status(data.message || 'Déverrouillage requis.', 'err');
    } else if (data.type === 'marexssh-root-ticket') {
      if (!pendingRoot || data.id !== pendingRoot) return;
      pendingRoot = null;
      authorizeRoot(data.ticket);
    } else if (data.type === 'marexssh-root-denied') {
      if (!pendingRoot || data.id !== pendingRoot) return;
      pendingRoot = null;
      sfStatus(data.message || 'Confirmation refusée.', 'err');
    } else if (data.type === 'marexssh-close') {
      disconnect(true);
      resetSession('', '');
    }
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!hostEl.value.trim() || !userEl.value.trim()) { status('Hôte et utilisateur requis.', 'err'); return; }
    if (authEl.value === 'key' && !keyEl.value.trim()) { status('Collez votre clé privée.', 'err'); return; }
    if (authEl.value === 'password' && !passEl.value) { status('Mot de passe requis.', 'err'); return; }
    goEl.disabled = true;
    status('Connexion…');
    requestTicket();
  });

  window.addEventListener('pagehide', () => disconnect(true));
})();
