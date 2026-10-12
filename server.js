'use strict';
// 72 Ventures Khata - one-file server. No packages to install: run with `node server.js`.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'db.json');
const IMG_DIR = path.join(DATA_DIR, 'images');   // notice photos
const isImg = id => /^[a-f0-9]{16}$/.test(id) && fs.existsSync(path.join(IMG_DIR, id + '.jpg'));
const dropImg = id => { try { if (/^[a-f0-9]{16}$/.test(id)) fs.unlinkSync(path.join(IMG_DIR, id + '.jpg')); } catch (e) {} };
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/manifest.webmanifest': 'manifest.webmanifest', '/sw.js': 'sw.js',
  '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/seal.png': 'seal.png', '/logo.jpg': 'logo.jpg' };
const TYPES = { html: 'text/html; charset=utf-8', webmanifest: 'application/manifest+json', js: 'text/javascript; charset=utf-8', png: 'image/png', jpg: 'image/jpeg' };
// Files may sit next to server.js or in a "public" folder; next to server.js wins.
const findFile = n => [path.join(__dirname, n), path.join(__dirname, 'public', n)].find(f => fs.existsSync(f));
const COLS = ['members', 'deposits', 'loans', 'repayments', 'entries', 'notices'];
const DEF_CFG = { name: '72 Ventures Pvt. Ltd.', shareValue: 200, minShares: 5, maxShares: 10, startMonth: '2026-11',
  loanRate: 8, loanLimitPct: 80, loanTermMax: 11, dueDay: 25, graceDays: 3, lateFee: 500,
  allocInvest: 50, allocLoan: 35, allocReserve: 15, bank: '', chair: '', treasurer: '', email: 'ventures72.official@gmail.com', openLedger: 'no' };

/* ---------- storage ---------- */
let db;
const today = () => new Date().toISOString().slice(0, 10);
const newId = () => crypto.randomBytes(8).toString('hex');
function hashPass(pw) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); }
function checkPass(pw, stored) {
  const [salt, h] = String(stored || ':').split(':');
  const a = crypto.scryptSync(String(pw), salt || 'x', 32), b = Buffer.from(h || '', 'hex');
  return b.length === a.length && crypto.timingSafeEqual(a, b);
}
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const bak = path.join(DATA_DIR, 'backup-' + today() + '.json');
  if (fs.existsSync(FILE) && !fs.existsSync(bak)) fs.copyFileSync(FILE, bak);   // one backup a day
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}
function boot() {
  if (fs.existsSync(FILE)) {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db.cfg = Object.assign({}, DEF_CFG, db.cfg);
    COLS.forEach(c => db[c] = db[c] || {}); db.log = db.log || [];
    fillSerials();
    return;
  }
  db = { secret: crypto.randomBytes(32).toString('hex'), cfg: { ...DEF_CFG } };
  COLS.forEach(c => db[c] = {}); db.log = [];
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  db.members.admin = { name: 'Admin', loginId: 'admin', pass: hashPass(pw), pv: 1, admin: true, mustChange: true,
    role: 'member', status: 'active', joined: today(), phone: '', address: '', note: '' };
  fillSerials();
  persist();
  console.log('\n  First start. Sign in with:\n    Login ID: admin\n    Password: ' + pw + '\n  You will be asked to set your own password.\n');
}

/* ---------- member numbers (given once, never reused) ---------- */
function giveSerial(m) { if (!m.serial && m.status !== 'pending') { db.nextSerial = db.nextSerial || 1; m.serial = db.nextSerial++; } }
function fillSerials() {   // older records: number them by join date
  db.nextSerial = Math.max(db.nextSerial || 1, ...Object.values(db.members).map(m => (m.serial || 0) + 1));
  Object.values(db.members).filter(m => !m.serial && m.status !== 'pending')
    .sort((a, b) => (b.admin ? 1 : 0) - (a.admin ? 1 : 0) || String(a.joined).localeCompare(String(b.joined)) || String(a.name).localeCompare(String(b.name)))
    .forEach(giveSerial);
}

/* ---------- sessions ---------- */
const sign = s => crypto.createHmac('sha256', db.secret).update(s).digest('base64url');
function makeToken(u) { const p = Buffer.from(JSON.stringify({ u: u.id, e: Date.now() + 30 * 864e5, v: u.pv || 1 })).toString('base64url'); return p + '.' + sign(p); }
function userFrom(req) {
  const m = /(?:^|;\s*)s=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return null;
  const [p, sig] = m[1].split('.'); if (!p || !sig) return null;
  const good = sign(p); if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  let t; try { t = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch (e) { return null; }
  const u = db.members[t.u];
  if (!u || t.e < Date.now() || (u.pv || 1) !== t.v || u.status === 'left' || u.status === 'pending' || !u.pass) return null;
  return { ...u, id: t.u };
}
const cookie = (req, tok, age) => `s=${tok}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${age}` +
  ((req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) ? '; Secure' : '');
const fails = new Map();   // loginId -> {n, until}

/* ---------- helpers ---------- */
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const num = v => { const n = Number(v); return isFinite(n) && n >= 0 ? n : 0; };
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v), isMonth = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
class Bad extends Error { constructor(code) { super(code); this.code = code; } }
const need = (ok, code = 'bad_input') => { if (!ok) throw new Bad(code); };
const rows = c => Object.entries(db[c]).map(([id, v]) => ({ ...v, id }));

/* ---------- change history (admins only, can only grow) ---------- */
const HIDE = new Set(['pass', 'pv', 'mustChange', 'memberId', 'loanId', 'id']);
const mName = id => (db.members[id] || {}).name || '?';
function labelOf(col, r) {
  if (!r) return '';
  if (col === 'members') return r.name;
  if (col === 'deposits') return mName(r.memberId) + ' · ' + r.month;
  if (col === 'loans') return mName(r.memberId) + ' · ' + r.principal;
  if (col === 'repayments') return mName((db.loans[r.loanId] || {}).memberId) + ' · ' + r.date;
  if (col === 'entries') return r.category;
  if (col === 'notices') return r.title;
  return '';
}
function diff(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (HIDE.has(k)) continue;
    const x = a ? String(a[k] ?? '') : '', y = b ? String(b[k] ?? '') : '';
    if (x === y) continue;
    out.push(a && b ? `${k}: ${x || '-'} → ${y || '-'}` : `${k}: ${x || y}`);
  }
  return out.join('; ').slice(0, 800);
}
function logIt(who, act, col, label, detail) {
  db.log.push({ t: new Date().toISOString(), by: who, act, col, label: String(label || '').slice(0, 120), detail });
  if (db.log.length > 5000) db.log.splice(0, db.log.length - 5000);
}

function totals() {
  const T = { dep: 0, shares: 0, fees: 0, repI: 0, lent: 0, out: 0, cash: 0, capital: 0, openLoans: 0, active: 0, perMonth: {}, paid: {} };
  const activeIds = new Set(rows('members').filter(m => m.status !== 'left' && m.status !== 'pending').map(m => m.id)); T.active = activeIds.size;
  for (const d of rows('deposits')) { T.dep += num(d.amount); T.shares += num(d.shares); T.fees += num(d.fee);
    T.perMonth[d.month] = (T.perMonth[d.month] || 0) + num(d.amount); if (activeIds.has(d.memberId)) T.paid[d.month] = (T.paid[d.month] || 0) + 1; }
  const paid = {}; let repP = 0;
  for (const r of rows('repayments')) { paid[r.loanId] = (paid[r.loanId] || 0) + num(r.principal); repP += num(r.principal); T.repI += num(r.interest); }
  for (const l of rows('loans')) { const o = Math.max(0, num(l.principal) - (paid[l.id] || 0)); T.lent += num(l.principal); T.out += o; if (o > 0) T.openLoans++; }
  let inc = 0, exp = 0; for (const e of rows('entries')) e.kind === 'expense' ? exp += num(e.amount) : inc += num(e.amount);
  T.cash = T.dep + T.fees + repP + T.repI + inc - exp - T.lent; T.capital = T.dep + T.fees + T.repI + inc - exp;
  return T;
}
function stateFor(u) {
  const admin = !!u.admin, open = admin || db.cfg.openLedger === 'yes';
  const base = { me: u.id, admin, open, mustChange: !!u.mustChange, cfg: db.cfg, log: admin && !u.mustChange ? db.log.slice(-400).reverse() : [] };
  if (u.mustChange) return { ...base, members: [], deposits: [], loans: [], repayments: [], entries: [], notices: [], totals: totals() };
  const view = m => admin ? { id: m.id, serial: m.serial || 0, name: m.name, phone: m.phone, address: m.address, role: m.role, joined: m.joined, status: m.status, note: m.note, loginId: m.loginId || '', admin: !!m.admin, hasPass: !!m.pass, nomineeName: m.nomineeName || '', nomineeRelation: m.nomineeRelation || '', nomineePhone: m.nomineePhone || '' }
    : m.id === u.id ? { id: m.id, serial: m.serial || 0, name: m.name, phone: m.phone, address: m.address, role: m.role, joined: m.joined, status: m.status, loginId: m.loginId || '', nomineeName: m.nomineeName || '', nomineeRelation: m.nomineeRelation || '', nomineePhone: m.nomineePhone || '' }
    : { id: m.id, serial: m.serial || 0, name: m.name, role: m.role, joined: m.joined, status: m.status };
  const mine = x => open || x.memberId === u.id;
  const loans = rows('loans').filter(mine), seen = new Set(loans.map(l => l.id));
  return { ...base, members: rows('members').filter(m => admin || (m.status !== 'pending' && (open || m.id === u.id))).map(view), deposits: rows('deposits').filter(mine), loans,
    repayments: rows('repayments').filter(r => seen.has(r.loanId)), entries: open ? rows('entries') : [], notices: rows('notices'), totals: totals() };
}

/* ---------- writes (admin only) ---------- */
function save(admin, col, id, d) {
  d = d || {};
  if (col === 'cfg') {
    const c = {}; for (const k of ['shareValue', 'minShares', 'maxShares', 'loanRate', 'loanLimitPct', 'loanTermMax', 'dueDay', 'graceDays', 'lateFee', 'allocInvest', 'allocLoan', 'allocReserve']) c[k] = num(d[k]);
    for (const k of ['name', 'bank', 'chair', 'treasurer', 'email']) c[k] = str(d[k]);
    c.startMonth = str(d.startMonth); c.openLedger = d.openLedger === 'yes' ? 'yes' : 'no';
    need(c.name && isMonth(c.startMonth) && c.shareValue > 0 && c.minShares >= 1 && c.maxShares >= c.minShares && c.allocInvest + c.allocLoan + c.allocReserve === 100);
    logIt(admin.name, 'edit', 'cfg', '', diff(db.cfg, c)); db.cfg = c; return;
  }
  need(COLS.includes(col));
  const old = id ? db[col][id] : null; need(!id || old || col === 'deposits');
  let rec;
  if (col === 'members') {
    rec = { ...(old || { pv: 1 }), name: str(d.name), phone: str(d.phone, 40), address: str(d.address), note: str(d.note, 500),
      nomineeName: str(d.nomineeName, 80), nomineeRelation: str(d.nomineeRelation, 40), nomineePhone: str(d.nomineePhone, 40),
      role: ['chair', 'treasurer', 'secretary'].includes(d.role) ? d.role : 'member', joined: isDate(d.joined) ? d.joined : today(), status: d.status === 'left' ? 'left' : 'active', admin: d.admin === 'yes' };
    need(rec.name);
    giveSerial(rec);   // new member, or a sign-up being approved
    need(!(id === admin.id && (!rec.admin || rec.status === 'left')), 'self_admin');
    const lid = str(d.loginId, 30).toLowerCase();
    if (lid) { need(/^[a-z0-9._-]{3,30}$/.test(lid), 'bad_login_id'); need(!rows('members').some(m => m.loginId === lid && m.id !== id), 'login_taken'); rec.loginId = lid; } else delete rec.loginId;
    if (d.password) { need(String(d.password).length >= 8, 'weak_password'); need(rec.loginId, 'bad_login_id'); rec.pass = hashPass(String(d.password)); rec.pv = (rec.pv || 1) + 1; rec.mustChange = id !== admin.id; rec._pw = 1; }
  } else if (col === 'deposits') {
    need(db.members[d.memberId] && isMonth(d.month) && isDate(d.date));
    const sh = num(d.shares); need(Number.isInteger(sh) && sh >= db.cfg.minShares && sh <= db.cfg.maxShares);
    id = d.memberId + '_' + d.month;
    const proof = (Array.isArray(d.proof) ? d.proof : []).map(String).filter(isImg).slice(0, 2);
    rec = { memberId: d.memberId, month: d.month, shares: sh, amount: sh * db.cfg.shareValue, fee: num(d.fee), date: d.date, note: str(d.note, 500), proof };
    if (db.deposits[id]) (db.deposits[id].proof || []).filter(x => !proof.includes(x)).forEach(dropImg);
  } else if (col === 'loans') {
    need(db.members[d.memberId] && isDate(d.issued) && num(d.principal) > 0 && num(d.term) >= 1);
    rec = { memberId: d.memberId, principal: num(d.principal), rate: num(d.rate), issued: d.issued, term: Math.round(num(d.term)), purpose: str(d.purpose, 500) };
  } else if (col === 'repayments') {
    need(db.loans[d.loanId] && isDate(d.date));
    rec = { loanId: d.loanId, date: d.date, principal: num(d.principal), interest: num(d.interest), note: str(d.note, 500) };
  } else if (col === 'entries') {
    need(isDate(d.date) && num(d.amount) > 0 && str(d.category));
    rec = { kind: d.kind === 'income' ? 'income' : 'expense', date: d.date, amount: num(d.amount), category: str(d.category), note: str(d.note, 500) };
  } else {
    need(isDate(d.date) && str(d.title) && (str(d.body, 5000) || (d.images || []).length));
    const imgs = (Array.isArray(d.images) ? d.images : []).map(String).filter(isImg).slice(0, 4);
    rec = { title: str(d.title), date: d.date, body: str(d.body, 5000), images: imgs };
    if (old) (old.images || []).filter(x => !imgs.includes(x)).forEach(dropImg);
  }
  const prev = col === 'deposits' ? db.deposits[id] : old, pw = rec._pw; delete rec._pw;
  const det = diff(prev, rec) + (pw ? (prev ? '; ' : '') + 'password: set by admin' : '');
  if (!prev || det) logIt(admin.name, prev ? 'edit' : 'add', col, labelOf(col, rec), det);
  db[col][id || newId()] = rec;
}
function remove(admin, col, id) {
  need(COLS.includes(col) && db[col][id]);
  if (col === 'members') { need(id !== admin.id, 'self_admin'); need(!rows('deposits').some(d => d.memberId === id) && !rows('loans').some(l => l.memberId === id), 'has_records'); }
  if (col === 'notices') (db.notices[id].images || []).forEach(dropImg);
  if (col === 'deposits') (db.deposits[id].proof || []).forEach(dropImg);
  if (col === 'loans') for (const r of rows('repayments')) if (r.loanId === id) delete db.repayments[r.id];
  logIt(admin.name, 'delete', col, labelOf(col, db[col][id]), diff(db[col][id], null));
  delete db[col][id];
}

/* ---------- http ---------- */
function send(res, code, obj, extra) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(obj)); }
function body(req, max = 2e5) { return new Promise((ok, no) => { let s = ''; req.on('data', c => { s += c; if (s.length > max) { no(new Bad('bad_input')); req.destroy(); } }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(new Bad('bad_input')); } }); req.on('error', no); }); }

async function handle(req, res) {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && STATIC[url]) {
    const f = findFile(STATIC[url]); if (!f) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': TYPES[f.split('.').pop()], 'Cache-Control': /\.(png|jpg)$/.test(url) ? 'max-age=86400' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    return fs.createReadStream(f).pipe(res);
  }
  const im = /^\/img\/([a-f0-9]{16})\.jpg$/.exec(url);
  if (req.method === 'GET' && im) {   // photos are for signed-in members only
    if (!userFrom(req)) return send(res, 401, { error: 'sign_in' });
    if (!isImg(im[1])) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000', 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(path.join(IMG_DIR, im[1] + '.jpg')).pipe(res);
  }
  if (!url.startsWith('/api/')) return send(res, 404, { error: 'not_found' });
  const act = url.slice(5);
  if (req.method === 'GET') {
    if (act !== 'state') return send(res, 404, { error: 'not_found' });
    const u = userFrom(req); return u ? send(res, 200, stateFor(u)) : send(res, 401, { error: 'sign_in', email: db.cfg.email || '' });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'bad_input' });
  const origin = req.headers.origin;   // block posts sent from other websites
  if (origin) { let h = ''; try { h = new URL(origin).host; } catch (e) {} if (h !== req.headers.host) return send(res, 403, { error: 'bad_input' }); }
  if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'bad_input' });
  const b = await body(req, act === 'upload' ? 6e6 : 2e5);

  if (act === 'login') {
    const lid = str(b.loginId, 30).toLowerCase(), f = fails.get(lid);
    if (f && f.until > Date.now()) return send(res, 429, { error: 'locked' });
    const m = rows('members').find(x => x.loginId === lid && x.status !== 'left' && x.pass);
    if (!checkPass(b.password || '', m ? m.pass : '00:00') || !m) {
      const n = (f && f.until > Date.now() - 9e5 ? f.n : 0) + 1; fails.set(lid, { n, until: n >= 8 ? Date.now() + 9e5 : 0 });
      return send(res, 401, { error: 'bad_login' });
    }
    fails.delete(lid);
    if (m.status === 'pending') return send(res, 403, { error: 'pending' });
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, makeToken(m), 2592000) });
  }
  if (act === 'signup') {   // a new member asks for an account; an admin must approve it
    const lid = str(b.loginId, 30).toLowerCase(), name = str(b.name, 80);
    need(name); need(/^[a-z0-9._-]{3,30}$/.test(lid), 'bad_login_id'); need(String(b.password || '').length >= 8, 'weak_password');
    need(!rows('members').some(m => m.loginId === lid), 'login_taken');
    need(rows('members').filter(m => m.status === 'pending').length < 30, 'signup_full');
    db.members[newId()] = { name, phone: str(b.phone, 40), address: '', note: '', role: 'member', joined: today(), status: 'pending', loginId: lid, pass: hashPass(String(b.password)), pv: 1, admin: false };
    logIt(name, 'signup', 'members', name, 'loginId: ' + lid);
    persist(); return send(res, 200, { ok: true });
  }
  if (act === 'logout') return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, 'x', 0) });

  const u = userFrom(req); if (!u) return send(res, 401, { error: 'sign_in' });
  if (act === 'password') {
    need(checkPass(b.current || '', u.pass), 'wrong_password'); need(String(b.next || '').length >= 8, 'weak_password');
    const m = db.members[u.id]; m.pass = hashPass(String(b.next)); m.pv = (m.pv || 1) + 1; delete m.mustChange; persist();
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, makeToken({ ...m, id: u.id }), 2592000) });
  }
  if (!u.admin || u.mustChange) return send(res, 403, { error: 'denied' });
  if (act === 'upload') {   // one photo, already made small (JPEG) by the browser
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
    need(m, 'bad_image'); const buf = Buffer.from(m[1], 'base64');
    need(buf.length > 100 && buf.length <= 3e6 && buf[0] === 0xFF && buf[1] === 0xD8, 'bad_image');
    fs.mkdirSync(IMG_DIR, { recursive: true }); const id = newId();
    fs.writeFileSync(path.join(IMG_DIR, id + '.jpg'), buf);
    return send(res, 200, { id });
  }
  if (act === 'save') { save(u, b.col, str(b.id), b.data); persist(); return send(res, 200, { ok: true }); }
  if (act === 'delete') { remove(u, b.col, str(b.id)); persist(); return send(res, 200, { ok: true }); }
  send(res, 404, { error: 'not_found' });
}

boot();
if (process.argv.includes('--reset-admin')) {   // forgot the admin password: node server.js --reset-admin
  const a = rows('members').find(m => m.admin && m.loginId); const pw = crypto.randomBytes(6).toString('base64url');
  if (a) { const m = db.members[a.id]; m.pass = hashPass(pw); m.pv = (m.pv || 1) + 1; m.mustChange = true; m.status = 'active'; persist(); console.log('Login ID: ' + m.loginId + '\nNew password: ' + pw); }
  process.exit(0);
}
http.createServer((req, res) => handle(req, res).catch(e => {
  if (!(e instanceof Bad)) console.error(e);
  if (!res.headersSent) send(res, e instanceof Bad ? 400 : 500, { error: e instanceof Bad ? e.code : 'server' });
})).listen(PORT, () => console.log('72 Ventures Khata is running on port ' + PORT));
