// Fonctions communes à la Gestion et à la Caisse
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const F = n => Math.round(n || 0).toLocaleString('fr-FR').replace(/ | /g, ' ') + ' F';
const fdate = iso => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fheure = iso => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fdt = iso => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) + ' ' + fheure(iso);
const dmy = d => d ? d.split('-').reverse().join('/') : '';
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const PAY_LABEL = { especes: 'Espèces', wave: 'Wave', orange_money: 'Orange Money', mtn_momo: 'MTN MoMo', moov_money: 'Moov Money', carte: 'Carte' };

async function api(path, opts) {
  opts = opts || {};
  let res, body;
  try {
    res = await fetch(path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
    body = await res.json();
  } catch (e) { throw new Error('Serveur injoignable. Vérifiez la connexion.'); }
  if (res.status === 401 && !opts.auth) { showAuth(); throw new Error('Session expirée'); }
  if (!res.ok || body.ok === false) throw new Error(body.error || 'Erreur');
  return body;
}

let _tt;
function toast(t, b, err) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.innerHTML = `<b>${esc(t)}</b>${b ? `<span>${esc(b)}</span>` : ''}`;
  el.classList.toggle('err', !!err); el.classList.add('on');
  clearTimeout(_tt); _tt = setTimeout(() => el.classList.remove('on'), err ? 5000 : 3500);
}

function openModal(html, wide) {
  let m = $('modal');
  if (!m) { m = document.createElement('div'); m.id = 'modal'; m.className = 'modal'; m.addEventListener('mousedown', e => { if (e.target === m) closeModal(); }); document.body.appendChild(m); }
  m.innerHTML = `<div class="mbox ${wide ? 'wide' : ''}"><button class="x" onclick="closeModal()">×</button>${html}</div>`;
  m.classList.add('on');
}
function closeModal() { const m = $('modal'); if (m) m.classList.remove('on'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// Demande le code secret de suppression
function askDeleteCode(label) {
  return new Promise(resolve => {
    openModal(`<div class="mt h">Confirmer la suppression</div><p class="hint" style="margin-bottom:12px">${esc(label)}<br>Saisissez le code secret de suppression.</p>
      <div class="fld"><input type="password" id="delcode" autocomplete="off" placeholder="Code de suppression"></div>
      <div class="mfoot"><button class="btn ghost" id="dc-no">Annuler</button><button class="btn" id="dc-ok">Supprimer</button></div>`);
    setTimeout(() => $('delcode').focus(), 50);
    $('dc-no').onclick = () => { closeModal(); resolve(null); };
    $('dc-ok').onclick = () => { const v = $('delcode').value; closeModal(); resolve(v || null); };
    $('delcode').onkeydown = e => { if (e.key === 'Enter') $('dc-ok').click(); };
  });
}

// Réduit une photo avant envoi (téléphone -> 1 200 px max, JPEG)
function resizeImage(file, max) {
  max = max || 1200;
  return new Promise((ok, ko) => {
    const fr = new FileReader();
    fr.onerror = () => ko(new Error('Lecture impossible'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => ko(new Error('Image illisible'));
      img.onload = () => {
        let { width: w, height: h } = img;
        const r = Math.min(1, max / Math.max(w, h)); w = Math.round(w * r); h = Math.round(h * r);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        ok(c.toDataURL('image/jpeg', 0.84));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
async function uploadImage(file, max) {
  const dataUrl = await resizeImage(file, max);
  const r = await api('/api/admin/upload', { body: { dataUrl } });
  return r.url;
}

// ---------- Connexion / première configuration ----------
let _onReady = null;
async function adminBoot(onReady) {
  _onReady = onReady;
  let s;
  try { s = await fetch('/api/session', { credentials: 'same-origin' }).then(r => r.json()); }
  catch (e) { document.body.innerHTML = '<div class="empty">Serveur injoignable.</div>'; return; }
  if (s.loggedIn) { hideAuth(); onReady(s); } else showAuth(s);
}
async function showAuth(s) {
  if (!s) s = await fetch('/api/session').then(r => r.json()).catch(() => ({ setupDone: true }));
  let el = $('auth');
  if (!el) { el = document.createElement('div'); el.id = 'auth'; el.className = 'auth'; document.body.appendChild(el); }
  el.style.display = 'flex';
  el.innerHTML = s.setupDone ? `<div class="ab"><div class="h">Connexion</div><p>${esc(s.resto || '')} — espace de la responsable</p>
      <div class="fld"><label>Identifiant</label><input id="au-u" autocomplete="username"></div>
      <div class="fld"><label>Mot de passe</label><input id="au-p" type="password" autocomplete="current-password"></div>
      <div class="err" id="au-e"></div><button class="btn big full" id="au-go">Se connecter</button></div>`
    : `<div class="ab"><div class="h">Bienvenue</div><p>Première utilisation : créez votre accès de responsable.</p>
      <div class="fld"><label>Nom du restaurant</label><input id="au-r" value="${esc(s.resto || '')}"></div>
      <div class="fld"><label>Identifiant</label><input id="au-u" autocomplete="username"></div>
      <div class="fld"><label>Mot de passe (4 caractères min.)</label><input id="au-p" type="password" autocomplete="new-password"></div>
      <div class="fld"><label>Code secret de suppression</label><input id="au-d" type="password" autocomplete="off"></div>
      <p class="hint" style="margin:0 0 10px;max-width:none">Ce code sera demandé pour supprimer une opération de caisse ou un article de stock. Il n’est jamais réaffiché : notez-le.</p>
      <div class="err" id="au-e"></div><button class="btn big full" id="au-go">Créer mon accès</button></div>`;
  const go = async () => {
    try {
      if (s.setupDone) await api('/api/login', { body: { username: $('au-u').value, password: $('au-p').value }, auth: true });
      else await api('/api/setup', { body: { restoNom: $('au-r').value, username: $('au-u').value, password: $('au-p').value, deleteCode: $('au-d').value }, auth: true });
      const s2 = await fetch('/api/session').then(r => r.json());
      hideAuth(); if (_onReady) _onReady(s2);
    } catch (e) { $('au-e').textContent = e.message; }
  };
  $('au-go').onclick = go;
  el.querySelectorAll('input').forEach(i => i.onkeydown = e => { if (e.key === 'Enter') go(); });
  setTimeout(() => { const f = el.querySelector('input'); if (f) f.focus(); }, 50);
}
function hideAuth() { const el = $('auth'); if (el) el.style.display = 'none'; }
async function logout() { await fetch('/api/logout', { method: 'POST' }); location.reload(); }

// ---------- Temps réel ----------
function adminStream(handlers, onState) {
  let es;
  const open = () => {
    es = new EventSource('/api/stream/admin');
    es.onopen = () => onState && onState(true);
    es.onerror = () => { onState && onState(false); };
    Object.keys(handlers).forEach(ev => es.addEventListener(ev, e => handlers[ev](JSON.parse(e.data))));
  };
  open();
  return () => es && es.close();
}
