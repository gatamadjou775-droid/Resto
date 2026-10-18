/**
 * RESTO — Serveur de la plateforme restaurant
 * -----------------------------------------------------------
 * Aucune dépendance externe : uniquement les modules intégrés à Node.js
 * (même architecture que Boutique TS et Sha'ah).
 *
 * TROIS INTERFACES, UNE SEULE BASE DE DONNÉES :
 *  - /             -> application CLIENT (menu, commande, suivi, QR de table,
 *                     réservation, devis, discussion, fidélité)
 *  - /gestion.html -> espace de la RESPONSABLE (commandes en temps réel,
 *                     menus, bannières, messages programmés, réservations...)
 *  - /caisse.html  -> CAISSE (entrées automatiques des commandes terminées,
 *                     sorties, charges, stock / inventaire, rapports)
 *  - /livreur.html -> page du livreur (partage de position pendant la course)
 *
 * Temps réel : Server-Sent Events (aucune bibliothèque) + notifications Web Push
 * (chiffrement RFC 8291 et signature VAPID faits avec le module crypto).
 *
 * Variables d'environnement (toutes optionnelles) :
 *   PORT       Port d'écoute
 *   DATA_FILE  Emplacement du fichier de données (par défaut ./data.json).
 *              Les images envoyées sont rangées dans un dossier "uploads"
 *              à côté de ce fichier (donc sur le disque persistant en ligne).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data.json');
const DATA_DIR = path.dirname(DATA_FILE);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const BACKUP_DIR = path.join(DATA_DIR, 'sauvegardes');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

// ============================================================
// OUTILS
// ============================================================
const makeSalt = () => crypto.randomBytes(16).toString('hex');
const hashSecret = (v, salt) => crypto.scryptSync(String(v), salt, 64).toString('hex');
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function randomCode(len, chars) {
  chars = chars || 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < len; i++) s += chars[crypto.randomInt(chars.length)]; return s;
}
const uid = () => crypto.randomBytes(5).toString('hex');
const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : (d || 0); };
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);
const nowIso = () => new Date().toISOString();

// Date/heure locale du restaurant (fuseau réglable, Abidjan par défaut)
function localParts(tz) {
  const d = new Date();
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Africa/Abidjan', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false })
    .formatToParts(d).forEach(x => { p[x.type] = x.value; });
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, weekday: wd };
}
const today = () => localParts(DB && DB.settings.resto.fuseau).date;

// ============================================================
// BASE DE DONNÉES (en mémoire + fichier JSON)
// ============================================================
let DB = null;

function seedData() {
  const ids = { c: 1 };
  const nid = () => ids.c++;
  const cat = (nom, couleur) => ({ id: nid(), nom, couleur, image: '', actif: true, ordre: ids.c });
  const cPays = cat('Plats du pays', '#E10600'), cGrill = cat('Grillades', '#0B3D2C'),
    cFast = cat('Fast-food', '#FFB703'), cAcc = cat('Accompagnements', '#7A3E00'),
    cBois = cat('Boissons', '#0F7B4A'), cDes = cat('Desserts', '#C2185B');
  const ch = (nom, prix) => ({ id: uid(), nom, prix: prix || 0 });
  const grp = (nom, type, requis, choix) => ({ id: uid(), nom, type, requis, choix });
  const stock = [
    { id: nid(), nom: 'Poulet entier', unite: 'pièce', quantite: 20, seuil: 5, cout: 3500 },
    { id: nid(), nom: 'Poisson (carpe)', unite: 'pièce', quantite: 25, seuil: 6, cout: 1500 },
    { id: nid(), nom: 'Attiéké', unite: 'kg', quantite: 15, seuil: 4, cout: 800 },
    { id: nid(), nom: 'Riz', unite: 'kg', quantite: 25, seuil: 5, cout: 600 },
    { id: nid(), nom: 'Banane plantain', unite: 'pièce', quantite: 60, seuil: 15, cout: 100 },
    { id: nid(), nom: 'Huile', unite: 'litre', quantite: 10, seuil: 3, cout: 1300 },
    { id: nid(), nom: 'Bissap (bouteille)', unite: 'bouteille', quantite: 40, seuil: 10, cout: 200 }
  ];
  const S = n => stock.find(s => s.nom === n).id;
  const plat = (o) => Object.assign({ id: nid(), description: '', image: '', actif: true, platDuJour: false, options: [], recette: [] }, o);
  const piment = grp('Piment', 'single', true, [ch('Sans piment'), ch('Doux'), ch('Fort')]);
  const plats = [
    plat({ nom: 'Attiéké poisson braisé', categorieId: cPays.id, prix: 3500, description: 'Carpe braisée au feu de bois, attiéké frais, oignons et tomates.', recette: [{ stockId: S('Poisson (carpe)'), qte: 1 }, { stockId: S('Attiéké'), qte: 0.3 }],
      options: [grp('Poisson', 'single', true, [ch('Carpe'), ch('Capitaine', 1500), ch('Thon')]), piment, grp('Suppléments', 'multi', false, [ch('Alloco', 500), ch('Œuf dur', 200), ch('Attiéké en plus', 300)])] }),
    plat({ nom: 'Kédjénou de poulet', categorieId: cPays.id, prix: 4500, platDuJour: true, description: 'Poulet mijoté à l’étouffée dans son jus, légumes et épices.', recette: [{ stockId: S('Poulet entier'), qte: 0.5 }],
      options: [grp('Accompagnement', 'single', true, [ch('Attiéké'), ch('Riz blanc'), ch('Foutou banane', 500)]), piment] }),
    plat({ nom: 'Foutou sauce graine', categorieId: cPays.id, prix: 4000, platDuJour: true, description: 'Foutou banane, sauce graine maison.', recette: [{ stockId: S('Banane plantain'), qte: 3 }],
      options: [grp('Viande', 'single', true, [ch('Poisson fumé'), ch('Bœuf', 500), ch('Escargots', 1500)])] }),
    plat({ nom: 'Riz sauce arachide', categorieId: cPays.id, prix: 3000, description: 'Riz parfumé, sauce arachide au poulet.', recette: [{ stockId: S('Riz'), qte: 0.25 }] }),
    plat({ nom: 'Garba', categorieId: cPays.id, prix: 1000, description: 'Attiéké et thon frit, le classique.', recette: [{ stockId: S('Attiéké'), qte: 0.25 }],
      options: [grp('Suppléments', 'multi', false, [ch('Œuf', 200), ch('Piment', 0), ch('Oignons', 0)])] }),
    plat({ nom: 'Poulet braisé', categorieId: cGrill.id, prix: 4000, description: 'Mariné 12 h, braisé à la commande.', recette: [{ stockId: S('Poulet entier'), qte: 0.5 }],
      options: [grp('Portion', 'single', true, [ch('Demi-poulet'), ch('Poulet entier', 3000)]), grp('Accompagnement', 'single', true, [ch('Attiéké'), ch('Alloco'), ch('Frites')]), piment] }),
    plat({ nom: 'Brochettes de bœuf', categorieId: cGrill.id, prix: 2500, description: '5 brochettes marinées, oignons grillés.' }),
    plat({ nom: 'Chawarma poulet', categorieId: cFast.id, prix: 2500, description: 'Poulet mariné, crudités, pain libanais.',
      options: [grp('Taille', 'single', true, [ch('Normal'), ch('Grand', 1000)]), grp('Sauces', 'multi', false, [ch('Mayonnaise'), ch('Ketchup'), ch('Piquante')])] }),
    plat({ nom: 'Burger maison', categorieId: cFast.id, prix: 3500, description: 'Steak haché, cheddar, oignons caramélisés, frites.',
      options: [grp('Cuisson', 'single', true, [ch('À point'), ch('Bien cuit')]), grp('Suppléments', 'multi', false, [ch('Double steak', 1500), ch('Œuf', 200)])] }),
    plat({ nom: 'Alloco', categorieId: cAcc.id, prix: 1000, recette: [{ stockId: S('Banane plantain'), qte: 2 }] }),
    plat({ nom: 'Frites', categorieId: cAcc.id, prix: 1000 }),
    plat({ nom: 'Attiéké nature', categorieId: cAcc.id, prix: 500, recette: [{ stockId: S('Attiéké'), qte: 0.2 }] }),
    plat({ nom: 'Bissap', categorieId: cBois.id, prix: 500, description: 'Fleurs d’hibiscus, menthe, bien frais.', recette: [{ stockId: S('Bissap (bouteille)'), qte: 1 }] }),
    plat({ nom: 'Gnamakoudji', categorieId: cBois.id, prix: 500, description: 'Jus de gingembre maison.' }),
    plat({ nom: 'Jus de baobab', categorieId: cBois.id, prix: 700 }),
    plat({ nom: 'Eau minérale 50 cl', categorieId: cBois.id, prix: 300 }),
    plat({ nom: 'Dégué', categorieId: cDes.id, prix: 800, description: 'Mil et lait caillé sucré.' }),
    plat({ nom: 'Salade de fruits', categorieId: cDes.id, prix: 1000 })
  ];
  const banners = [
    { id: nid(), image: '', titre: 'CUISINE DU JOUR', texte: 'Kédjénou de poulet et foutou sauce graine, servis dès midi.', couleur: 'vert', lien: 'menu', actif: true, ordre: 1 },
    { id: nid(), image: '', titre: 'COMMANDEZ DEPUIS VOTRE TABLE', texte: 'Scannez le QR code posé sur la table, on vous prévient quand c’est prêt.', couleur: 'rouge', lien: '', actif: true, ordre: 2 },
    { id: nid(), image: '', titre: 'VOS ÉVÉNEMENTS', texte: 'Anniversaires, mariages, séminaires : demandez un devis en 2 minutes.', couleur: 'jaune', lien: 'devis', actif: true, ordre: 3 }
  ];
  return { ids, categories: [cPays, cGrill, cFast, cAcc, cBois, cDes], plats, stock, banners };
}

function defaultData() {
  const seed = seedData();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  void publicKey;
  return {
    nextId: seed.ids.c + 10,
    nextNumero: 1001,
    settings: {
      setupDone: false, adminUser: '', pwSalt: '', pwHash: '', delSalt: '', delHash: '',
      vapid: { publicKey: pub.toString('base64url'), privateJwk: jwk },
      nbTables: 12,
      fondsCaisse: 0,
      resto: {
        nom: 'SAVEURS D’ICI', slogan: 'La cuisine de chez nous, livrée chaude',
        adresse: 'Cocody, Abidjan', tel: '', whatsapp: '', email: '',
        horaires: 'Tous les jours, 10 h – 23 h', ouvert: true,
        fraisLivraison: 1000, minCommande: 0, delai: '25 – 40 min',
        lat: 5.3599, lng: -3.9870, fuseau: 'Africa/Abidjan',
        pointsParMille: 1, valeurPoint: 20, seuilPoints: 50
      }
    },
    categories: seed.categories, plats: seed.plats, banners: seed.banners, stock: seed.stock,
    commandes: [], clients: [], annonces: [], notifs: [], programmes: [
      { id: seed.ids.c + 1, titre: 'La cuisine du jour', corps: 'Bonjour ! Aujourd’hui chez {restaurant} : {plats_du_jour}. Commandez dès maintenant.', heure: '09:00', jours: [1, 2, 3, 4, 5, 6, 0], actif: false, dernierEnvoi: '' }
    ],
    reservations: [], devis: [], chats: [], mouvements: [], stockMvts: []
  };
}

function loadDB() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
  try { DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { DB = defaultData(); saveDB(); return; }
  const def = defaultData();
  for (const k of Object.keys(def)) if (DB[k] === undefined) DB[k] = def[k];
  DB.settings.resto = Object.assign({}, def.settings.resto, DB.settings.resto || {});
  if (!DB.settings.vapid) DB.settings.vapid = def.settings.vapid;
  saveDB();
}
function saveDB() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB));
  fs.renameSync(tmp, DATA_FILE);
}
const nextId = () => DB.nextId++;
function backupIfNeeded() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `data-${new Date().toISOString().slice(0, 10)}.json`);
    if (!fs.existsSync(dest)) fs.copyFileSync(DATA_FILE, dest);
  } catch (e) { console.error('Sauvegarde impossible :', e.message); }
}

// ============================================================
// SESSIONS (responsable) + ANTI BRUTE-FORCE
// ============================================================
const sessions = new Map();
const SESSION_TTL = 12 * 3600 * 1000;
function getSession(req) {
  const sid = parseCookies(req).sid;
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(sid); return null; }
  return s;
}
const attempts = new Map();
function rateOk(key, max, windowMs) {
  const now = Date.now(); const r = attempts.get(key);
  if (!r || now > r.resetAt) { attempts.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  return ++r.count <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now > s.expires) sessions.delete(k);
  for (const [k, r] of attempts) if (now > r.resetAt) attempts.delete(k);
}, 3600 * 1000);

function parseCookies(req) {
  const out = {}; (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }); return out;
}
function setSessionCookie(req, res, sid, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

// ============================================================
// TEMPS RÉEL (Server-Sent Events)
// ============================================================
const adminStreams = new Set();
const clientStreams = new Map(); // clientId -> Set(res)
function sseOpen(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
}
function sseSend(res, ev, data) { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* fermé */ } }
const toAdmin = (ev, d) => { for (const r of adminStreams) sseSend(r, ev, d); };
const toClient = (cid, ev, d) => { const s = clientStreams.get(cid); if (s) for (const r of s) sseSend(r, ev, d); };
const toAllClients = (ev, d) => { for (const s of clientStreams.values()) for (const r of s) sseSend(r, ev, d); };
setInterval(() => {
  for (const r of adminStreams) { try { r.write(': ping\n\n'); } catch (e) { } }
  for (const s of clientStreams.values()) for (const r of s) { try { r.write(': ping\n\n'); } catch (e) { } }
}, 25000);

// ============================================================
// WEB PUSH (VAPID + chiffrement aes128gcm, RFC 8291/8292)
// ============================================================
function vapidAuthHeader(endpoint) {
  const v = DB.settings.vapid;
  const aud = new URL(endpoint).origin;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sub = 'mailto:' + (DB.settings.resto.email || 'infos@acdees.com');
  const unsigned = b64({ typ: 'JWT', alg: 'ES256' }) + '.' + b64({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub });
  const key = crypto.createPrivateKey({ key: v.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${unsigned}.${sig}, k=${v.publicKey}`;
}
function encryptPush(sub, payload) {
  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = 65;
  return Buffer.concat([header, asPublic, ct]);
}
function sendPush(client, payloadObj) {
  if (!client.push || !client.push.length) return;
  const payload = JSON.stringify(payloadObj);
  client.push.slice().forEach(sub => {
    let body, auth;
    try { body = encryptPush(sub, payload); auth = vapidAuthHeader(sub.endpoint); } catch (e) { return; }
    const u = new URL(sub.endpoint);
    const req = https.request({ method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, TTL: '86400', Urgency: 'high', Authorization: auth } }, (r) => {
      r.resume();
      if (r.statusCode === 404 || r.statusCode === 410) {
        client.push = client.push.filter(s => s.endpoint !== sub.endpoint); saveDB();
      }
    });
    req.on('error', () => { });
    req.setTimeout(10000, () => req.destroy());
    req.end(body);
  });
}

// Notification personnelle (commande, réservation, devis, discussion)
function notifyClient(clientId, titre, corps, extra) {
  const client = DB.clients.find(c => c.id === clientId);
  if (!client) return;
  const n = { id: nextId(), clientId, titre, corps, at: nowIso(), lu: false, type: (extra && extra.type) || 'info', ref: (extra && extra.ref) || null };
  DB.notifs.push(n);
  if (DB.notifs.length > 5000) DB.notifs = DB.notifs.slice(-4000);
  toClient(clientId, 'notif', n);
  sendPush(client, { title: titre, body: corps, tag: n.type + '-' + (n.ref || n.id), url: '/?vue=' + (n.type === 'commande' ? 'commandes' : n.type === 'chat' ? 'chat' : 'notifs') });
}
// Message à tous les clients (annonce, cuisine du jour...)
function broadcast(titre, corps, image) {
  const a = { id: nextId(), titre, corps, image: image || '', at: nowIso() };
  DB.annonces.push(a);
  if (DB.annonces.length > 500) DB.annonces = DB.annonces.slice(-400);
  saveDB();
  toAllClients('annonce', a);
  let n = 0;
  DB.clients.forEach(c => { if (c.push && c.push.length) { n++; sendPush(c, { title: titre, body: corps, tag: 'annonce-' + a.id, url: '/?vue=notifs' }); } });
  return { annonce: a, pushes: n };
}
function fillTemplate(t) {
  const pdj = DB.plats.filter(p => p.platDuJour && p.actif).map(p => p.nom);
  return String(t || '')
    .replace(/\{restaurant\}/g, DB.settings.resto.nom)
    .replace(/\{plats_du_jour\}/g, pdj.length ? pdj.join(', ') : 'nos plats du jour');
}

// Messages programmés : vérification toutes les 30 secondes
setInterval(() => {
  if (!DB) return;
  const lp = localParts(DB.settings.resto.fuseau);
  DB.programmes.forEach(p => {
    if (!p.actif || p.dernierEnvoi === lp.date) return;
    if (!(p.jours || []).includes(lp.weekday)) return;
    if (lp.time < p.heure) return;
    // On n'envoie pas un message du matin à 22 h si le serveur a été éteint toute la journée
    const [h, m] = p.heure.split(':').map(Number), [h2, m2] = lp.time.split(':').map(Number);
    p.dernierEnvoi = lp.date;
    if ((h2 * 60 + m2) - (h * 60 + m) > 120) { saveDB(); return; }
    broadcast(fillTemplate(p.titre), fillTemplate(p.corps));
  });
}, 30000);

// ============================================================
// MÉTIER : commandes, caisse, stock, fidélité
// ============================================================
const STATUTS = ['recue', 'acceptee', 'preparation', 'prete', 'en_livraison', 'terminee', 'annulee'];
const STATUT_MSG = {
  acceptee: ['Commande acceptée', 'Votre commande n°{n} est acceptée. La cuisine s’y met.'],
  preparation: ['En cuisine', 'Votre commande n°{n} est en préparation.'],
  prete: ['Votre plat est prêt !', 'La commande n°{n} est prête.'],
  en_livraison: ['En route', 'Votre commande n°{n} est en route. Suivez le livreur sur la carte.'],
  terminee: ['Bon appétit !', 'Commande n°{n} terminée. Merci, donnez-nous votre avis.'],
  annulee: ['Commande annulée', 'La commande n°{n} a été annulée.']
};

function computeOrder(body, client) {
  const r = DB.settings.resto;
  const items = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
  if (!items.length) throw new Error('Votre panier est vide.');
  const lignes = [];
  let sousTotal = 0;
  for (const it of items) {
    const plat = DB.plats.find(p => p.id === Number(it.platId));
    if (!plat || !plat.actif) throw new Error(`« ${plat ? plat.nom : 'Un plat'} » n’est plus disponible.`);
    const cat = DB.categories.find(c => c.id === plat.categorieId);
    if (cat && !cat.actif) throw new Error(`« ${plat.nom} » n’est plus disponible.`);
    let unit = plat.prix; const opts = [];
    const sel = it.options || {};
    for (const g of plat.options || []) {
      let ids = Array.isArray(sel[g.id]) ? sel[g.id] : (sel[g.id] ? [sel[g.id]] : []);
      ids = ids.filter(id => g.choix.some(c => c.id === id));
      if (g.type === 'single') ids = ids.slice(0, 1);
      if (g.requis && !ids.length) throw new Error(`Choisissez « ${g.nom} » pour ${plat.nom}.`);
      ids.forEach(id => { const c = g.choix.find(x => x.id === id); unit += num(c.prix); opts.push({ groupe: g.nom, choix: c.nom, prix: num(c.prix) }); });
    }
    const qte = Math.max(1, Math.min(50, Math.round(num(it.qte, 1))));
    lignes.push({ platId: plat.id, nom: plat.nom, prixUnit: unit, qte, options: opts, note: str(it.note, 200), total: unit * qte });
    sousTotal += unit * qte;
  }
  const mode = ['livraison', 'sur_place', 'emporter'].includes(body.mode) ? body.mode : 'livraison';
  const frais = mode === 'livraison' ? num(r.fraisLivraison) : 0;
  if (r.minCommande && sousTotal < r.minCommande) throw new Error(`Commande minimum : ${r.minCommande} F CFA.`);
  let points = Math.max(0, Math.floor(num(body.points)));
  let remise = 0;
  if (points) {
    if (!client || client.points < points) throw new Error('Points de fidélité insuffisants.');
    if (points < r.seuilPoints) throw new Error(`Il faut au moins ${r.seuilPoints} points pour les utiliser.`);
    // Les points paient au maximum la moitié du panier
    points = Math.min(points, Math.floor(Math.floor(sousTotal / 2) / r.valeurPoint));
    remise = points * r.valeurPoint;
  }
  return { lignes, sousTotal, frais, remise, points, total: sousTotal + frais - remise, mode };
}

function comptabiliser(c) {
  if (c.comptabilisee) return;
  c.comptabilisee = true;
  DB.mouvements.push({ id: nextId(), date: today(), at: nowIso(), type: 'entree', categorie: 'Ventes', libelle: `Commande n°${c.numero}${c.clientNom ? ' — ' + c.clientNom : ''}`, montant: c.total, paiement: c.paiement, commandeId: c.id, auto: true });
  // Inventaire en temps réel : on retire les ingrédients des recettes
  const alertes = [];
  c.lignes.forEach(l => {
    const plat = DB.plats.find(p => p.id === l.platId);
    (plat && plat.recette || []).forEach(rc => {
      const s = DB.stock.find(x => x.id === rc.stockId); if (!s) return;
      const q = num(rc.qte) * l.qte;
      s.quantite = Math.round((s.quantite - q) * 1000) / 1000;
      DB.stockMvts.push({ id: nextId(), at: nowIso(), stockId: s.id, type: 'vente', quantite: -q, motif: `Commande n°${c.numero}` });
      if (s.quantite <= s.seuil) alertes.push(s);
    });
  });
  if (alertes.length) toAdmin('alerte', { titre: 'Stock bas', corps: alertes.map(s => `${s.nom} : ${s.quantite} ${s.unite}`).join(' · ') });
  // Fidélité
  const client = DB.clients.find(x => x.id === c.clientId);
  if (client && !client.invite) {
    const gain = Math.floor(c.total / 1000) * num(DB.settings.resto.pointsParMille, 1);
    client.points = (client.points || 0) + gain; c.pointsGagnes = gain;
  }
}

function setStatut(c, statut) {
  if (!STATUTS.includes(statut)) throw new Error('Statut inconnu');
  if (c.statut === 'terminee' || c.statut === 'annulee') throw new Error('Cette commande est déjà clôturée.');
  c.statut = statut;
  c.historique.push({ statut, at: nowIso() });
  if (statut === 'en_livraison' && !c.livreurKey) c.livreurKey = randomCode(10);
  if (statut === 'terminee') comptabiliser(c);
  if (statut === 'annulee' && c.pointsUtilises) {
    const cl = DB.clients.find(x => x.id === c.clientId); if (cl) cl.points += c.pointsUtilises;
  }
  saveDB();
  const m = STATUT_MSG[statut];
  if (m) {
    let corps = m[1].replace('{n}', c.numero);
    if (statut === 'prete' && c.mode === 'sur_place' && c.table) corps += ` On vous l’apporte à la table ${c.table}.`;
    if (statut === 'prete' && c.mode === 'emporter') corps += ' Vous pouvez venir la récupérer au comptoir.';
    notifyClient(c.clientId, m[0], corps, { type: 'commande', ref: c.id });
  }
  toClient(c.clientId, 'commande', clientOrderView(c));
  toAdmin('commande', c);
  saveDB();
}

const clientOrderView = c => { const o = Object.assign({}, c); delete o.livreurKey; return o; };
const clientPublic = c => ({ id: c.id, nom: c.nom, tel: c.tel, adresse: c.adresse || '', points: c.points || 0, invite: !!c.invite, notifs: !!(c.push && c.push.length) });
const adminClientView = c => ({ id: c.id, nom: c.nom, tel: c.tel, adresse: c.adresse || '', points: c.points || 0, invite: !!c.invite, createdAt: c.createdAt, push: !!(c.push && c.push.length) });

function ratings() {
  const acc = {};
  DB.commandes.forEach(c => {
    if (!c.avis || !c.avis.note) return;
    c.lignes.forEach(l => { const a = acc[l.platId] || (acc[l.platId] = { s: 0, n: 0 }); a.s += c.avis.note; a.n++; });
  });
  const out = {}; for (const k in acc) out[k] = { moyenne: Math.round(acc[k].s / acc[k].n * 10) / 10, nombre: acc[k].n };
  return out;
}

// ============================================================
// HTTP
// ============================================================
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function readBody(req, maxBytes) {
  maxBytes = maxBytes || 12 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > maxBytes) { reject(new HttpError(413, 'Fichier trop volumineux')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch (e) { reject(new HttpError(400, 'Données invalides')); } });
    req.on('error', reject);
  });
}

function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) fail(400, 'Image invalide (PNG, JPG ou WEBP).');
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = Date.now().toString(36) + '-' + uid() + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[2], 'base64'));
  return '/uploads/' + name;
}
function removeImage(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const f = path.join(UPLOAD_DIR, path.basename(url));
  fs.unlink(f, () => { });
}

function serveFile(res, filePath, cache) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Page introuvable'); }
    const ext = path.extname(filePath).toLowerCase();
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (cache) h['Cache-Control'] = 'public, max-age=604800';
    else h['Cache-Control'] = 'no-cache';
    if (path.basename(filePath) === 'sw.js') h['Service-Worker-Allowed'] = '/';
    res.writeHead(200, h); res.end(data);
  });
}

// ---------- Mini routeur ----------
const routes = [];
function route(method, pattern, auth, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, auth, handler });
}
function getClient(req, query) {
  const token = req.headers['x-client-token'] || (query && query.get('token'));
  if (!token) return null;
  return DB.clients.find(c => c.tokens && c.tokens.some(t => safeEqual(t, token))) || null;
}
const findOr404 = (arr, id, what) => arr.find(x => x.id === Number(id)) || fail(404, (what || 'Élément') + ' introuvable');
function checkDeleteCode(ctx) {
  if (!rateOk('del:' + ctx.ip, 5, 60000)) fail(429, 'Trop de tentatives. Patientez une minute.');
  const h = hashSecret(ctx.body.code || '', DB.settings.delSalt);
  if (!safeEqual(h, DB.settings.delHash)) fail(403, 'Code de suppression incorrect');
}

// ============================================================
// ROUTES — PUBLIC
// ============================================================
route('GET', '/api/public/menu', null, () => {
  const s = DB.settings;
  const r = Object.assign({}, s.resto);
  return {
    ok: true, resto: r, nbTables: s.nbTables, vapidKey: s.vapid.publicKey,
    categories: DB.categories.filter(c => c.actif).sort((a, b) => a.ordre - b.ordre),
    plats: DB.plats.filter(p => p.actif && (DB.categories.find(c => c.id === p.categorieId) || {}).actif !== false).map(p => { const o = Object.assign({}, p); delete o.recette; return o; }),
    banners: DB.banners.filter(b => b.actif).sort((a, b) => a.ordre - b.ordre),
    ratings: ratings()
  };
});

// ============================================================
// ROUTES — CLIENT
// ============================================================
function issueToken(client) {
  const t = crypto.randomBytes(24).toString('hex');
  client.tokens = (client.tokens || []).slice(-4); client.tokens.push(t);
  return t;
}
const normTel = t => String(t || '').replace(/[^\d+]/g, '');

route('POST', '/api/client/inscription', null, (ctx) => {
  if (!rateOk('insc:' + ctx.ip, 10, 15 * 60000)) fail(429, 'Trop de tentatives, réessayez plus tard.');
  const nom = str(ctx.body.nom, 60), tel = normTel(ctx.body.tel), pin = String(ctx.body.pin || '');
  if (!nom || tel.length < 8) fail(400, 'Nom et numéro de téléphone valides requis.');
  if (!/^\d{4}$/.test(pin)) fail(400, 'Le code secret doit faire 4 chiffres.');
  if (DB.clients.some(c => c.tel === tel && !c.invite)) fail(409, 'Ce numéro a déjà un compte. Connectez-vous.');
  const salt = makeSalt();
  const c = { id: nextId(), nom, tel, pinSalt: salt, pinHash: hashSecret(pin, salt), adresse: '', points: 0, push: [], tokens: [], createdAt: nowIso() };
  // Récupérer les commandes passées en invité (même appareil)
  const prev = getClient(ctx.req);
  if (prev && prev.invite) { DB.commandes.forEach(o => { if (o.clientId === prev.id) o.clientId = c.id; }); c.push = prev.push || []; }
  const token = issueToken(c);
  DB.clients.push(c); saveDB();
  toAdmin('client', adminClientView(c));
  return { ok: true, token, client: clientPublic(c) };
});

route('POST', '/api/client/connexion', null, (ctx) => {
  if (!rateOk('cnx:' + ctx.ip, 10, 15 * 60000)) fail(429, 'Trop de tentatives, réessayez dans 15 minutes.');
  const tel = normTel(ctx.body.tel);
  const c = DB.clients.find(x => x.tel === tel && !x.invite);
  if (!c || !safeEqual(hashSecret(String(ctx.body.pin || ''), c.pinSalt), c.pinHash)) fail(401, 'Numéro ou code secret incorrect.');
  const token = issueToken(c); saveDB();
  return { ok: true, token, client: clientPublic(c) };
});

// Client à table (QR) : il commande juste avec son prénom
route('POST', '/api/client/invite', null, (ctx) => {
  if (!rateOk('inv:' + ctx.ip, 30, 15 * 60000)) fail(429, 'Trop de tentatives.');
  const nom = str(ctx.body.nom, 40) || 'Client';
  const c = { id: nextId(), nom, tel: normTel(ctx.body.tel), invite: true, points: 0, push: [], tokens: [], createdAt: nowIso() };
  const token = issueToken(c); DB.clients.push(c); saveDB();
  return { ok: true, token, client: clientPublic(c) };
});

route('GET', '/api/client/moi', 'client', (ctx) => ({ ok: true, client: clientPublic(ctx.client) }));
route('PUT', '/api/client/moi', 'client', (ctx) => {
  const c = ctx.client;
  if (ctx.body.nom) c.nom = str(ctx.body.nom, 60);
  if (ctx.body.adresse !== undefined) c.adresse = str(ctx.body.adresse, 200);
  saveDB(); return { ok: true, client: clientPublic(c) };
});
route('POST', '/api/client/deconnexion', 'client', (ctx) => {
  const t = ctx.req.headers['x-client-token'];
  ctx.client.tokens = (ctx.client.tokens || []).filter(x => x !== t);
  if (ctx.body.endpoint) ctx.client.push = (ctx.client.push || []).filter(s => s.endpoint !== ctx.body.endpoint);
  saveDB(); return { ok: true };
});
route('POST', '/api/client/push', 'client', (ctx) => {
  const s = ctx.body.subscription;
  if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) fail(400, 'Abonnement invalide');
  DB.clients.forEach(c => { if (c.push) c.push = c.push.filter(x => x.endpoint !== s.endpoint); });
  ctx.client.push = (ctx.client.push || []).concat([{ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }]).slice(-5);
  saveDB();
  return { ok: true };
});

route('GET', '/api/client/donnees', 'client', (ctx) => {
  const id = ctx.client.id;
  const lus = new Set(ctx.client.annoncesLues || []);
  const since = ctx.client.createdAt ? new Date(new Date(ctx.client.createdAt).getTime() - 7 * 86400000).toISOString() : '';
  return {
    ok: true, client: clientPublic(ctx.client),
    commandes: DB.commandes.filter(c => c.clientId === id).slice(-30).reverse().map(clientOrderView),
    notifs: DB.notifs.filter(n => n.clientId === id).slice(-60)
      .concat(DB.annonces.filter(a => a.at >= since).slice(-30).map(a => ({ id: a.id, titre: a.titre, corps: a.corps, image: a.image, at: a.at, type: 'annonce', lu: lus.has(a.id) })))
      .sort((a, b) => b.at.localeCompare(a.at)),
    reservations: DB.reservations.filter(r => r.clientId === id).slice(-20).reverse(),
    devis: DB.devis.filter(d => d.clientId === id).slice(-20).reverse(),
    chat: DB.chats.filter(m => m.clientId === id).slice(-200)
  };
});
route('POST', '/api/client/notifs/lu', 'client', (ctx) => {
  DB.notifs.forEach(n => { if (n.clientId === ctx.client.id) n.lu = true; });
  ctx.client.annoncesLues = DB.annonces.slice(-60).map(a => a.id);
  saveDB(); return { ok: true };
});

// ---------- Commandes ----------
route('POST', '/api/commandes', 'client', (ctx) => {
  if (!rateOk('cmd:' + ctx.ip, 20, 10 * 60000)) fail(429, 'Trop de commandes en peu de temps. Patientez un instant.');
  const r = DB.settings.resto;
  if (!r.ouvert) fail(409, 'Le restaurant est actuellement fermé. Revenez pendant nos horaires : ' + r.horaires);
  const b = ctx.body, client = ctx.client;
  let calc;
  try { calc = computeOrder(b, client); } catch (e) { fail(400, e.message); }
  const tel = normTel(b.tel) || client.tel;
  const adresse = str(b.adresse, 250);
  const pos = b.position && isFinite(b.position.lat) && isFinite(b.position.lng) ? { lat: Number(b.position.lat), lng: Number(b.position.lng) } : null;
  const table = calc.mode === 'sur_place' ? Math.max(0, Math.min(999, Math.round(num(b.table)))) : 0;
  if (calc.mode === 'livraison') {
    if (!adresse && !pos) fail(400, 'Indiquez votre adresse de livraison ou partagez votre position.');
    if (!tel || tel.length < 8) fail(400, 'Un numéro de téléphone est nécessaire pour la livraison.');
  }
  if (calc.mode === 'sur_place' && !table) fail(400, 'Indiquez votre numéro de table.');
  const paiement = ['especes', 'wave', 'orange_money', 'mtn_momo', 'moov_money', 'carte'].includes(b.paiement) ? b.paiement : 'especes';
  if (calc.points) client.points -= calc.points;
  const c = {
    id: nextId(), numero: DB.nextNumero++, at: nowIso(), date: today(),
    clientId: client.id, clientNom: client.nom, tel, mode: calc.mode, table, adresse, position: pos,
    lignes: calc.lignes, sousTotal: calc.sousTotal, frais: calc.frais, remise: calc.remise, pointsUtilises: calc.points, total: calc.total,
    paiement, note: str(b.note, 300), statut: 'recue', historique: [{ statut: 'recue', at: nowIso() }], livreurPos: null
  };
  if (calc.mode === 'livraison' && adresse && !client.adresse) client.adresse = adresse;
  DB.commandes.push(c); saveDB();
  toAdmin('commande', c);
  toAdmin('nouvelle', { numero: c.numero, total: c.total, mode: c.mode, table: c.table, client: c.clientNom });
  return { ok: true, commande: clientOrderView(c), client: clientPublic(client) };
});
route('POST', '/api/commandes/:id/annuler', 'client', (ctx) => {
  const c = findOr404(DB.commandes, ctx.params.id, 'Commande');
  if (c.clientId !== ctx.client.id) fail(403, 'Accès refusé');
  if (c.statut !== 'recue') fail(409, 'La cuisine a déjà accepté la commande. Contactez-nous pour l’annuler.');
  setStatut(c, 'annulee');
  return { ok: true, commande: clientOrderView(c) };
});
route('POST', '/api/commandes/:id/avis', 'client', (ctx) => {
  const c = findOr404(DB.commandes, ctx.params.id, 'Commande');
  if (c.clientId !== ctx.client.id) fail(403, 'Accès refusé');
  if (c.statut !== 'terminee') fail(409, 'Vous pourrez noter la commande une fois terminée.');
  const note = Math.max(1, Math.min(5, Math.round(num(ctx.body.note))));
  c.avis = { note, commentaire: str(ctx.body.commentaire, 400), at: nowIso() };
  saveDB(); toAdmin('commande', c);
  return { ok: true, commande: clientOrderView(c) };
});

// ---------- Réservations, devis, discussion ----------
route('POST', '/api/reservations', 'client', (ctx) => {
  const b = ctx.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || !/^\d{2}:\d{2}$/.test(b.heure || '')) fail(400, 'Date et heure requises.');
  const personnes = Math.max(1, Math.min(500, Math.round(num(b.personnes, 2))));
  const r = { id: nextId(), at: nowIso(), clientId: ctx.client.id, nom: str(b.nom, 60) || ctx.client.nom, tel: normTel(b.tel) || ctx.client.tel,
    date: b.date, heure: b.heure, personnes, espace: str(b.espace, 40) || 'Salle', occasion: str(b.occasion, 60), note: str(b.note, 400), statut: 'demandee', reponse: '' };
  if (!r.tel) fail(400, 'Un numéro de téléphone est nécessaire.');
  DB.reservations.push(r); saveDB();
  toAdmin('reservation', r);
  return { ok: true, reservation: r };
});
route('POST', '/api/reservations/:id/annuler', 'client', (ctx) => {
  const r = findOr404(DB.reservations, ctx.params.id, 'Réservation');
  if (r.clientId !== ctx.client.id) fail(403, 'Accès refusé');
  r.statut = 'annulee'; saveDB(); toAdmin('reservation', r);
  return { ok: true, reservation: r };
});
route('POST', '/api/devis', 'client', (ctx) => {
  const b = ctx.body;
  const d = { id: nextId(), at: nowIso(), clientId: ctx.client.id, nom: str(b.nom, 60) || ctx.client.nom, tel: normTel(b.tel) || ctx.client.tel,
    evenement: str(b.evenement, 60), date: str(b.date, 10), invites: Math.max(1, Math.round(num(b.invites, 10))), lieu: str(b.lieu, 120),
    formule: str(b.formule, 60), budget: num(b.budget), description: str(b.description, 1200), statut: 'nouveau', montant: 0, reponse: '' };
  if (!d.evenement || !d.date) fail(400, 'Type d’événement et date requis.');
  if (!d.tel) fail(400, 'Un numéro de téléphone est nécessaire.');
  DB.devis.push(d); saveDB(); toAdmin('devis', d);
  return { ok: true, devis: d };
});
route('POST', '/api/devis/:id/decision', 'client', (ctx) => {
  const d = findOr404(DB.devis, ctx.params.id, 'Devis');
  if (d.clientId !== ctx.client.id) fail(403, 'Accès refusé');
  if (d.statut !== 'propose') fail(409, 'Aucune proposition en attente.');
  d.statut = ctx.body.accepte ? 'accepte' : 'refuse'; saveDB(); toAdmin('devis', d);
  return { ok: true, devis: d };
});
route('POST', '/api/client/chat', 'client', (ctx) => {
  if (!rateOk('chat:' + ctx.ip, 40, 60000)) fail(429, 'Doucement, patientez quelques secondes.');
  const texte = str(ctx.body.texte, 1000);
  if (!texte) fail(400, 'Message vide');
  const m = { id: nextId(), clientId: ctx.client.id, de: 'client', texte, at: nowIso(), lu: false };
  DB.chats.push(m); saveDB();
  toAdmin('chat', Object.assign({ clientNom: ctx.client.nom, clientTel: ctx.client.tel }, m));
  toClient(ctx.client.id, 'chat', m);
  return { ok: true, message: m };
});

// ---------- Flux temps réel client ----------
route('GET', '/api/stream/client', 'stream-client', (ctx) => {
  const { req, res, client } = ctx;
  sseOpen(req, res);
  if (!clientStreams.has(client.id)) clientStreams.set(client.id, new Set());
  clientStreams.get(client.id).add(res);
  req.on('close', () => { const s = clientStreams.get(client.id); if (s) { s.delete(res); if (!s.size) clientStreams.delete(client.id); } });
  return 'STREAM';
});

// ============================================================
// ROUTES — LIVREUR (lien secret par commande)
// ============================================================
function livreurOrder(ctx) {
  const c = findOr404(DB.commandes, ctx.query.get('c') || ctx.body.c, 'Commande');
  const k = ctx.query.get('k') || ctx.body.k || '';
  if (!c.livreurKey || !safeEqual(k, c.livreurKey)) fail(403, 'Lien de livraison invalide');
  return c;
}
route('GET', '/api/livreur/commande', null, (ctx) => {
  const c = livreurOrder(ctx);
  return { ok: true, commande: { numero: c.numero, clientNom: c.clientNom, tel: c.tel, adresse: c.adresse, position: c.position, total: c.total, paiement: c.paiement, lignes: c.lignes, statut: c.statut, note: c.note }, resto: { nom: DB.settings.resto.nom, lat: DB.settings.resto.lat, lng: DB.settings.resto.lng } };
});
route('POST', '/api/livreur/position', null, (ctx) => {
  const c = livreurOrder(ctx);
  if (c.statut !== 'en_livraison') fail(409, 'La course est terminée.');
  const lat = Number(ctx.body.lat), lng = Number(ctx.body.lng);
  if (!isFinite(lat) || !isFinite(lng)) fail(400, 'Position invalide');
  c.livreurPos = { lat, lng, at: nowIso() };
  saveDB();
  toClient(c.clientId, 'position', { id: c.id, pos: c.livreurPos });
  toAdmin('position', { id: c.id, pos: c.livreurPos });
  return { ok: true };
});
route('POST', '/api/livreur/livree', null, (ctx) => {
  const c = livreurOrder(ctx);
  if (c.statut !== 'en_livraison') fail(409, 'La course est déjà clôturée.');
  setStatut(c, 'terminee');
  return { ok: true };
});

// ============================================================
// ROUTES — RESPONSABLE (gestion + caisse)
// ============================================================
route('GET', '/api/session', null, (ctx) => {
  const s = getSession(ctx.req);
  return { loggedIn: !!s, username: s ? s.username : null, setupDone: DB.settings.setupDone, resto: DB.settings.resto.nom };
});
route('POST', '/api/setup', null, (ctx) => {
  if (DB.settings.setupDone) fail(403, 'La configuration a déjà été effectuée.');
  const u = str(ctx.body.username, 40), p = String(ctx.body.password || ''), d = String(ctx.body.deleteCode || '').trim();
  if (!u || p.length < 4 || d.length < 4) fail(400, 'Identifiant, mot de passe (min. 4) et code de suppression (min. 4) requis.');
  const s = DB.settings;
  s.adminUser = u; s.pwSalt = makeSalt(); s.pwHash = hashSecret(p, s.pwSalt);
  s.delSalt = makeSalt(); s.delHash = hashSecret(d, s.delSalt); s.setupDone = true;
  if (ctx.body.restoNom) s.resto.nom = str(ctx.body.restoNom, 60);
  saveDB();
  const sid = crypto.randomBytes(24).toString('hex'); sessions.set(sid, { username: u, expires: Date.now() + SESSION_TTL });
  setSessionCookie(ctx.req, ctx.res, sid, SESSION_TTL / 1000);
  return { ok: true, username: u };
});
route('POST', '/api/login', null, (ctx) => {
  if (!rateOk('login:' + ctx.ip, 8, 15 * 60000)) fail(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  const s = DB.settings;
  const okU = s.adminUser && safeEqual(str(ctx.body.username, 40), s.adminUser);
  const okP = safeEqual(hashSecret(ctx.body.password || '', s.pwSalt || 'x'), s.pwHash || '');
  if (!okU || !okP) fail(401, 'Identifiant ou mot de passe incorrect');
  const sid = crypto.randomBytes(24).toString('hex'); sessions.set(sid, { username: s.adminUser, expires: Date.now() + SESSION_TTL });
  setSessionCookie(ctx.req, ctx.res, sid, SESSION_TTL / 1000);
  return { ok: true, username: s.adminUser };
});
route('POST', '/api/logout', null, (ctx) => {
  const sid = parseCookies(ctx.req).sid; if (sid) sessions.delete(sid);
  ctx.res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
  return { ok: true };
});

route('GET', '/api/admin/bootstrap', 'admin', () => {
  const s = DB.settings;
  return {
    ok: true,
    settings: { resto: s.resto, nbTables: s.nbTables, fondsCaisse: s.fondsCaisse, adminUser: s.adminUser },
    categories: DB.categories, plats: DB.plats, banners: DB.banners, stock: DB.stock, stockMvts: DB.stockMvts.slice(-500),
    commandes: DB.commandes.slice(-800), clients: DB.clients.map(adminClientView), annonces: DB.annonces.slice(-50).reverse(),
    programmes: DB.programmes, reservations: DB.reservations.slice(-300), devis: DB.devis.slice(-300), chats: DB.chats.slice(-3000),
    mouvements: DB.mouvements, ratings: ratings(), now: localParts(s.resto.fuseau)
  };
});
route('GET', '/api/stream/admin', 'admin', (ctx) => {
  sseOpen(ctx.req, ctx.res); adminStreams.add(ctx.res);
  ctx.req.on('close', () => adminStreams.delete(ctx.res));
  return 'STREAM';
});

// ---------- Réglages ----------
route('PUT', '/api/admin/resto', 'admin', (ctx) => {
  const r = DB.settings.resto, b = ctx.body;
  ['nom', 'slogan', 'adresse', 'tel', 'whatsapp', 'email', 'horaires', 'delai', 'fuseau'].forEach(k => { if (b[k] !== undefined) r[k] = str(b[k], 200); });
  ['fraisLivraison', 'minCommande', 'lat', 'lng', 'pointsParMille', 'valeurPoint', 'seuilPoints'].forEach(k => { if (b[k] !== undefined) r[k] = num(b[k]); });
  if (b.ouvert !== undefined) r.ouvert = !!b.ouvert;
  if (b.nbTables !== undefined) DB.settings.nbTables = Math.max(0, Math.min(300, Math.round(num(b.nbTables))));
  if (b.fondsCaisse !== undefined) DB.settings.fondsCaisse = num(b.fondsCaisse);
  try { new Intl.DateTimeFormat('fr', { timeZone: r.fuseau }); } catch (e) { r.fuseau = 'Africa/Abidjan'; }
  saveDB(); toAllClients('menu', {});
  return { ok: true, resto: r, nbTables: DB.settings.nbTables, fondsCaisse: DB.settings.fondsCaisse };
});
route('POST', '/api/admin/securite', 'admin', (ctx) => {
  const s = DB.settings, b = ctx.body;
  if (!safeEqual(hashSecret(b.currentPassword || '', s.pwSalt), s.pwHash)) fail(401, 'Mot de passe actuel incorrect');
  if (b.newUsername) s.adminUser = str(b.newUsername, 40);
  if (b.newPassword) { if (String(b.newPassword).length < 4) fail(400, 'Mot de passe trop court'); s.pwSalt = makeSalt(); s.pwHash = hashSecret(b.newPassword, s.pwSalt); }
  if (b.newDeleteCode) { if (String(b.newDeleteCode).length < 4) fail(400, 'Code trop court'); s.delSalt = makeSalt(); s.delHash = hashSecret(b.newDeleteCode, s.delSalt); }
  saveDB(); return { ok: true, username: s.adminUser };
});
route('POST', '/api/admin/upload', 'admin', (ctx) => ({ ok: true, url: saveImage(ctx.body.dataUrl) }));

// ---------- Catégories ----------
route('POST', '/api/admin/categories', 'admin', (ctx) => {
  const nom = str(ctx.body.nom, 60); if (!nom) fail(400, 'Nom requis');
  const c = { id: nextId(), nom, couleur: str(ctx.body.couleur, 20) || '#E10600', image: str(ctx.body.image, 200), actif: ctx.body.actif !== false, ordre: DB.categories.length + 1 };
  DB.categories.push(c); saveDB(); toAllClients('menu', {});
  return { ok: true, categorie: c };
});
route('PUT', '/api/admin/categories/:id', 'admin', (ctx) => {
  const c = findOr404(DB.categories, ctx.params.id, 'Catégorie'), b = ctx.body;
  if (b.nom !== undefined) c.nom = str(b.nom, 60) || c.nom;
  if (b.couleur !== undefined) c.couleur = str(b.couleur, 20);
  if (b.image !== undefined) { if (c.image && c.image !== b.image) removeImage(c.image); c.image = str(b.image, 200); }
  if (b.actif !== undefined) c.actif = !!b.actif;
  if (b.ordre !== undefined) c.ordre = num(b.ordre);
  saveDB(); toAllClients('menu', {});
  return { ok: true, categorie: c };
});
route('POST', '/api/admin/categories/:id/delete', 'admin', (ctx) => {
  const c = findOr404(DB.categories, ctx.params.id, 'Catégorie');
  if (DB.plats.some(p => p.categorieId === c.id)) fail(409, 'Déplacez ou supprimez d’abord les plats de cette catégorie.');
  DB.categories = DB.categories.filter(x => x !== c); removeImage(c.image); saveDB(); toAllClients('menu', {});
  return { ok: true };
});

// ---------- Plats ----------
function cleanOptions(opts) {
  return (Array.isArray(opts) ? opts : []).slice(0, 12).map(g => ({
    id: str(g.id, 20) || uid(), nom: str(g.nom, 50) || 'Option', type: g.type === 'multi' ? 'multi' : 'single', requis: !!g.requis,
    choix: (Array.isArray(g.choix) ? g.choix : []).slice(0, 20).filter(c => str(c.nom)).map(c => ({ id: str(c.id, 20) || uid(), nom: str(c.nom, 50), prix: num(c.prix) }))
  })).filter(g => g.choix.length);
}
function applyPlat(p, b) {
  if (b.nom !== undefined) p.nom = str(b.nom, 80);
  if (b.description !== undefined) p.description = str(b.description, 400);
  if (b.prix !== undefined) p.prix = Math.max(0, num(b.prix));
  if (b.categorieId !== undefined) p.categorieId = Number(b.categorieId);
  if (b.image !== undefined) { if (p.image && p.image !== b.image) removeImage(p.image); p.image = str(b.image, 200); }
  if (b.actif !== undefined) p.actif = !!b.actif;
  if (b.platDuJour !== undefined) p.platDuJour = !!b.platDuJour;
  if (b.options !== undefined) p.options = cleanOptions(b.options);
  if (b.recette !== undefined) p.recette = (Array.isArray(b.recette) ? b.recette : []).map(r => ({ stockId: Number(r.stockId), qte: num(r.qte) })).filter(r => r.qte > 0 && DB.stock.some(s => s.id === r.stockId));
}
route('POST', '/api/admin/plats', 'admin', (ctx) => {
  const p = { id: nextId(), nom: '', description: '', prix: 0, categorieId: 0, image: '', actif: true, platDuJour: false, options: [], recette: [] };
  applyPlat(p, ctx.body);
  if (!p.nom || !p.prix) fail(400, 'Nom et prix requis');
  if (!DB.categories.some(c => c.id === p.categorieId)) fail(400, 'Choisissez une catégorie');
  DB.plats.push(p); saveDB(); toAllClients('menu', {});
  return { ok: true, plat: p };
});
route('PUT', '/api/admin/plats/:id', 'admin', (ctx) => {
  const p = findOr404(DB.plats, ctx.params.id, 'Plat'); applyPlat(p, ctx.body);
  saveDB(); toAllClients('menu', {});
  return { ok: true, plat: p };
});
route('POST', '/api/admin/plats/:id/delete', 'admin', (ctx) => {
  const p = findOr404(DB.plats, ctx.params.id, 'Plat');
  DB.plats = DB.plats.filter(x => x !== p); removeImage(p.image); saveDB(); toAllClients('menu', {});
  return { ok: true };
});

// ---------- Bannières défilantes ----------
route('POST', '/api/admin/banners', 'admin', (ctx) => {
  const b = ctx.body;
  const ban = { id: nextId(), image: str(b.image, 200), titre: str(b.titre, 60), texte: str(b.texte, 160), couleur: ['vert', 'rouge', 'jaune'].includes(b.couleur) ? b.couleur : 'vert', lien: str(b.lien, 30), actif: b.actif !== false, ordre: DB.banners.length + 1 };
  if (!ban.image && !ban.titre) fail(400, 'Ajoutez une image ou un titre');
  DB.banners.push(ban); saveDB(); toAllClients('menu', {});
  return { ok: true, banner: ban };
});
route('PUT', '/api/admin/banners/:id', 'admin', (ctx) => {
  const ban = findOr404(DB.banners, ctx.params.id, 'Bannière'), b = ctx.body;
  ['titre', 'texte', 'lien'].forEach(k => { if (b[k] !== undefined) ban[k] = str(b[k], 160); });
  if (b.couleur !== undefined) ban.couleur = b.couleur;
  if (b.image !== undefined) { if (ban.image && ban.image !== b.image) removeImage(ban.image); ban.image = str(b.image, 200); }
  if (b.actif !== undefined) ban.actif = !!b.actif;
  if (b.ordre !== undefined) ban.ordre = num(b.ordre);
  saveDB(); toAllClients('menu', {});
  return { ok: true, banner: ban };
});
route('POST', '/api/admin/banners/:id/delete', 'admin', (ctx) => {
  const ban = findOr404(DB.banners, ctx.params.id, 'Bannière');
  DB.banners = DB.banners.filter(x => x !== ban); removeImage(ban.image); saveDB(); toAllClients('menu', {});
  return { ok: true };
});

// ---------- Commandes ----------
route('POST', '/api/admin/commandes/:id/statut', 'admin', (ctx) => {
  const c = findOr404(DB.commandes, ctx.params.id, 'Commande');
  try { setStatut(c, ctx.body.statut); } catch (e) { fail(409, e.message); }
  return { ok: true, commande: c };
});
// Prise de commande au comptoir / par téléphone par la responsable
route('POST', '/api/admin/commandes', 'admin', (ctx) => {
  let calc; try { calc = computeOrder(ctx.body, null); } catch (e) { fail(400, e.message); }
  const nom = str(ctx.body.clientNom, 60) || 'Client comptoir';
  const c = { id: nextId(), numero: DB.nextNumero++, at: nowIso(), date: today(), clientId: 0, clientNom: nom, tel: normTel(ctx.body.tel), mode: calc.mode,
    table: Math.round(num(ctx.body.table)), adresse: str(ctx.body.adresse, 250), position: null, lignes: calc.lignes, sousTotal: calc.sousTotal, frais: calc.frais,
    remise: 0, pointsUtilises: 0, total: calc.sousTotal + calc.frais, paiement: ctx.body.paiement || 'especes', note: str(ctx.body.note, 300), statut: 'acceptee',
    historique: [{ statut: 'recue', at: nowIso() }, { statut: 'acceptee', at: nowIso() }], source: 'comptoir' };
  DB.commandes.push(c); saveDB(); toAdmin('commande', c);
  return { ok: true, commande: c };
});

// ---------- Messages aux clients ----------
route('POST', '/api/admin/annonces', 'admin', (ctx) => {
  const titre = str(ctx.body.titre, 80), corps = str(ctx.body.corps, 500);
  if (!titre || !corps) fail(400, 'Titre et message requis');
  const r = broadcast(fillTemplate(titre), fillTemplate(corps), str(ctx.body.image, 200));
  return { ok: true, annonce: r.annonce, pushes: r.pushes, enLigne: clientStreams.size };
});
function applyProg(p, b) {
  if (b.titre !== undefined) p.titre = str(b.titre, 80);
  if (b.corps !== undefined) p.corps = str(b.corps, 500);
  if (b.heure !== undefined) { if (!/^\d{2}:\d{2}$/.test(b.heure)) fail(400, 'Heure invalide'); p.heure = b.heure; }
  if (b.jours !== undefined) p.jours = (Array.isArray(b.jours) ? b.jours : []).map(Number).filter(d => d >= 0 && d <= 6);
  if (b.actif !== undefined) { p.actif = !!b.actif; }
}
route('POST', '/api/admin/programmes', 'admin', (ctx) => {
  const p = { id: nextId(), titre: '', corps: '', heure: '09:00', jours: [0, 1, 2, 3, 4, 5, 6], actif: true, dernierEnvoi: '' };
  applyProg(p, ctx.body);
  if (!p.titre || !p.corps) fail(400, 'Titre et message requis');
  // Si l'heure est déjà passée aujourd'hui, le premier envoi se fera demain
  const lp = localParts(DB.settings.resto.fuseau); if (lp.time > p.heure) p.dernierEnvoi = lp.date;
  DB.programmes.push(p); saveDB(); return { ok: true, programme: p };
});
route('PUT', '/api/admin/programmes/:id', 'admin', (ctx) => {
  const p = findOr404(DB.programmes, ctx.params.id, 'Message');
  const wasOff = !p.actif; applyProg(p, ctx.body);
  const lp = localParts(DB.settings.resto.fuseau);
  if ((ctx.body.heure !== undefined || (wasOff && p.actif)) && lp.time > p.heure) p.dernierEnvoi = lp.date;
  saveDB(); return { ok: true, programme: p };
});
route('POST', '/api/admin/programmes/:id/delete', 'admin', (ctx) => {
  DB.programmes = DB.programmes.filter(p => p.id !== Number(ctx.params.id)); saveDB(); return { ok: true };
});
route('POST', '/api/admin/programmes/:id/envoyer', 'admin', (ctx) => {
  const p = findOr404(DB.programmes, ctx.params.id, 'Message');
  const r = broadcast(fillTemplate(p.titre), fillTemplate(p.corps));
  return { ok: true, pushes: r.pushes };
});

// ---------- Réservations & devis ----------
route('POST', '/api/admin/reservations/:id', 'admin', (ctx) => {
  const r = findOr404(DB.reservations, ctx.params.id, 'Réservation');
  const st = ctx.body.statut;
  if (!['confirmee', 'refusee', 'honoree', 'annulee'].includes(st)) fail(400, 'Statut invalide');
  r.statut = st; r.reponse = str(ctx.body.reponse, 400); saveDB();
  const lib = { confirmee: 'Réservation confirmée', refusee: 'Réservation refusée', annulee: 'Réservation annulée' }[st];
  if (lib) notifyClient(r.clientId, lib, `${r.date.split('-').reverse().join('/')} à ${r.heure}, ${r.personnes} pers.${r.reponse ? ' — ' + r.reponse : ''}`, { type: 'reservation', ref: r.id });
  toClient(r.clientId, 'reservation', r); toAdmin('reservation', r);
  return { ok: true, reservation: r };
});
route('POST', '/api/admin/devis/:id', 'admin', (ctx) => {
  const d = findOr404(DB.devis, ctx.params.id, 'Devis');
  const st = ctx.body.statut;
  if (!['propose', 'refuse', 'termine'].includes(st)) fail(400, 'Statut invalide');
  d.statut = st; if (ctx.body.montant !== undefined) d.montant = num(ctx.body.montant); if (ctx.body.reponse !== undefined) d.reponse = str(ctx.body.reponse, 1200);
  saveDB();
  if (st === 'propose') notifyClient(d.clientId, 'Votre devis est prêt', `${d.evenement} : ${d.montant.toLocaleString('fr-FR')} F CFA. Ouvrez l’app pour accepter.`, { type: 'devis', ref: d.id });
  if (st === 'refuse') notifyClient(d.clientId, 'Réponse à votre demande de devis', d.reponse || 'Nous ne pouvons pas donner suite à cette demande.', { type: 'devis', ref: d.id });
  toClient(d.clientId, 'devis', d); toAdmin('devis', d);
  return { ok: true, devis: d };
});

// ---------- Discussion ----------
route('POST', '/api/admin/chat/:clientId', 'admin', (ctx) => {
  const cl = findOr404(DB.clients, ctx.params.clientId, 'Client');
  const texte = str(ctx.body.texte, 1000); if (!texte) fail(400, 'Message vide');
  const m = { id: nextId(), clientId: cl.id, de: 'resto', texte, at: nowIso(), lu: false };
  DB.chats.push(m);
  DB.chats.forEach(x => { if (x.clientId === cl.id && x.de === 'client') x.lu = true; });
  saveDB();
  toClient(cl.id, 'chat', m); toAdmin('chat', Object.assign({ clientNom: cl.nom, clientTel: cl.tel }, m));
  sendPush(cl, { title: DB.settings.resto.nom, body: texte, tag: 'chat', url: '/?vue=chat' });
  return { ok: true, message: m };
});
route('POST', '/api/admin/chat/:clientId/lu', 'admin', (ctx) => {
  DB.chats.forEach(x => { if (x.clientId === Number(ctx.params.clientId) && x.de === 'client') x.lu = true; }); saveDB();
  return { ok: true };
});

// ---------- Caisse : mouvements ----------
route('POST', '/api/admin/mouvements', 'admin', (ctx) => {
  const b = ctx.body;
  const m = { id: nextId(), date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : today(), at: nowIso(), type: b.type === 'entree' ? 'entree' : 'sortie',
    categorie: str(b.categorie, 40) || 'Divers', libelle: str(b.libelle, 120), montant: Math.abs(num(b.montant)), paiement: str(b.paiement, 20) || 'especes', note: str(b.note, 300), auto: false };
  if (!m.libelle || !m.montant) fail(400, 'Libellé et montant requis');
  DB.mouvements.push(m); saveDB(); toAdmin('mouvement', m);
  return { ok: true, mouvement: m };
});
route('POST', '/api/admin/mouvements/:id/delete', 'admin', (ctx) => {
  checkDeleteCode(ctx);
  const m = findOr404(DB.mouvements, ctx.params.id, 'Opération');
  if (m.commandeId) { const c = DB.commandes.find(x => x.id === m.commandeId); if (c) c.comptabilisee = false; }
  DB.mouvements = DB.mouvements.filter(x => x !== m); saveDB(); toAdmin('mouvement', { deleted: m.id });
  return { ok: true };
});

// ---------- Stock / inventaire ----------
route('POST', '/api/admin/stock', 'admin', (ctx) => {
  const b = ctx.body; const nom = str(b.nom, 60); if (!nom) fail(400, 'Nom requis');
  const s = { id: nextId(), nom, unite: str(b.unite, 20) || 'pièce', quantite: num(b.quantite), seuil: num(b.seuil), cout: num(b.cout) };
  DB.stock.push(s); saveDB(); return { ok: true, stock: s };
});
route('PUT', '/api/admin/stock/:id', 'admin', (ctx) => {
  const s = findOr404(DB.stock, ctx.params.id, 'Article'), b = ctx.body;
  if (b.nom !== undefined) s.nom = str(b.nom, 60) || s.nom;
  if (b.unite !== undefined) s.unite = str(b.unite, 20);
  if (b.seuil !== undefined) s.seuil = num(b.seuil);
  if (b.cout !== undefined) s.cout = num(b.cout);
  saveDB(); return { ok: true, stock: s };
});
// Approvisionnement : le stock monte et (si payé en caisse) une sortie est enregistrée
route('POST', '/api/admin/stock/:id/entree', 'admin', (ctx) => {
  const s = findOr404(DB.stock, ctx.params.id, 'Article'), b = ctx.body;
  const q = num(b.quantite); if (q <= 0) fail(400, 'Quantité invalide');
  const total = num(b.coutTotal);
  s.quantite = Math.round((s.quantite + q) * 1000) / 1000;
  if (total > 0) s.cout = Math.round(total / q);
  const mv = { id: nextId(), at: nowIso(), stockId: s.id, type: 'achat', quantite: q, motif: str(b.fournisseur, 80) || 'Approvisionnement', cout: total };
  DB.stockMvts.push(mv);
  let m = null;
  if (total > 0 && b.payeCaisse !== false) {
    m = { id: nextId(), date: today(), at: nowIso(), type: 'sortie', categorie: 'Achats marchandises', libelle: `${s.nom} × ${q} ${s.unite}${b.fournisseur ? ' — ' + str(b.fournisseur, 60) : ''}`, montant: total, paiement: str(b.paiement, 20) || 'especes', auto: true, stockMvtId: mv.id };
    DB.mouvements.push(m);
  }
  saveDB(); if (m) toAdmin('mouvement', m);
  return { ok: true, stock: s, mouvement: m };
});
// Inventaire : on saisit la quantité réellement comptée, l'écart est tracé
route('POST', '/api/admin/stock/:id/inventaire', 'admin', (ctx) => {
  const s = findOr404(DB.stock, ctx.params.id, 'Article');
  const reel = num(ctx.body.quantite, NaN); if (!isFinite(reel) || reel < 0) fail(400, 'Quantité invalide');
  const ecart = Math.round((reel - s.quantite) * 1000) / 1000;
  s.quantite = reel;
  DB.stockMvts.push({ id: nextId(), at: nowIso(), stockId: s.id, type: 'inventaire', quantite: ecart, motif: str(ctx.body.motif, 120) || 'Inventaire' });
  saveDB(); return { ok: true, stock: s, ecart };
});
route('POST', '/api/admin/stock/:id/delete', 'admin', (ctx) => {
  checkDeleteCode(ctx);
  const s = findOr404(DB.stock, ctx.params.id, 'Article');
  DB.stock = DB.stock.filter(x => x !== s);
  DB.plats.forEach(p => { p.recette = (p.recette || []).filter(r => r.stockId !== s.id); });
  saveDB(); return { ok: true };
});

// ============================================================
// SERVEUR
// ============================================================
const server = http.createServer(async (req, res) => {
  let parsed;
  try { parsed = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  const urlPath = decodeURIComponent(parsed.pathname);
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  try {
    if (urlPath.startsWith('/api/')) {
      const r = routes.find(x => x.method === req.method && x.re.test(urlPath));
      if (!r) return sendJSON(res, 404, { ok: false, error: 'Route inconnue' });
      const m = r.re.exec(urlPath); const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const ctx = { req, res, params, query: parsed.searchParams, ip, body: {} };
      if (r.auth === 'admin' && !getSession(req)) return sendJSON(res, 401, { ok: false, error: 'Non authentifié' });
      if (r.auth === 'client' || r.auth === 'stream-client') {
        ctx.client = getClient(req, r.auth === 'stream-client' ? parsed.searchParams : null);
        if (!ctx.client) return sendJSON(res, 401, { ok: false, error: 'Session client expirée, reconnectez-vous.' });
      }
      if (req.method === 'POST' || req.method === 'PUT') ctx.body = await readBody(req);
      const out = await r.handler(ctx);
      if (out === 'STREAM') return;
      return sendJSON(res, 200, out);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (urlPath.startsWith('/uploads/')) return serveFile(res, path.join(UPLOAD_DIR, path.basename(urlPath)), true);
    const safe = urlPath === '/' ? '/index.html' : urlPath;
    const fp = path.normalize(path.join(PUBLIC_DIR, safe));
    if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    return serveFile(res, fp, safe.startsWith('/vendor/') || safe.startsWith('/fonts/'));
  } catch (e) {
    if (e instanceof HttpError) return sendJSON(res, e.status, { ok: false, error: e.message });
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: 'Erreur serveur' });
  }
});

loadDB();
backupIfNeeded();
setInterval(backupIfNeeded, 6 * 3600 * 1000);

server.listen(PORT, () => {
  const ips = [];
  Object.values(os.networkInterfaces()).forEach(l => (l || []).forEach(i => { if (i.family === 'IPv4' && !i.internal) ips.push(i.address); }));
  console.log('');
  console.log('==========================================================');
  console.log('   ' + DB.settings.resto.nom + ' — serveur démarré (port ' + PORT + ')');
  console.log('   Application client : http://localhost:' + PORT);
  console.log('   Gestion            : http://localhost:' + PORT + '/gestion.html');
  console.log('   Caisse             : http://localhost:' + PORT + '/caisse.html');
  ips.forEach(ip => console.log('   Sur le Wi-Fi       : http://' + ip + ':' + PORT));
  console.log('==========================================================');
  if (!DB.settings.setupDone) console.log('   Première utilisation : ouvrez /gestion.html pour créer votre accès.');
  console.log('');
});
