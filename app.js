// Home Base: a private logbook for the house, the cars and the projects.
// Single-page app. Data lives in Firestore under users/{uid}/{collection}/{id}, synced live.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { initializeFirestore, getFirestore, persistentLocalCache, collection, doc, getDoc, setDoc, deleteDoc, onSnapshot, writeBatch } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAw57oCNI8tpI6Lqs7KdoyvI_MGPZDFnYY",
  authDomain: "trailhead-almanac.firebaseapp.com",
  projectId: "trailhead-almanac",
  storageBucket: "trailhead-almanac.firebasestorage.app",
  messagingSenderId: "164229632017",
  appId: "1:164229632017:web:fb5a1be5dfd28a2465e1b0"
};

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 20);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const parseDate = s => { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = s => { const d = parseDate(s); return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : ''; };
const daysUntil = s => { const d = parseDate(s); if (!d) return null; const t = parseDate(today()); return Math.round((d - t) / 86400000); };
const addInterval = (s, n, unit) => { const d = parseDate(s) || parseDate(today()); if (unit === 'weeks') d.setDate(d.getDate() + 7 * n); else if (unit === 'years') d.setFullYear(d.getFullYear() + n); else d.setMonth(d.getMonth() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const money = n => n == null || n === '' ? '' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const slugify = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'page';
const dueLabel = s => { const n = daysUntil(s); if (n == null) return ['', 'm']; if (n < 0) return [`${-n}d overdue`, 'm over']; if (n === 0) return ['today', 'm due']; if (n <= 30) return [`in ${n}d`, 'm due']; return [fmtDate(s), 'm']; };
const by = (k, dir = 1) => (a, b) => ((a[k] ?? '') > (b[k] ?? '') ? 1 : (a[k] ?? '') < (b[k] ?? '') ? -1 : 0) * dir;

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (isError ? ' error' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2200);
}

// ---------------------------------------------------------------- schema
const AREAS = ['House', 'Car', 'Yard', 'Other'];
const SCHEMA = {
  assets: { one: 'Asset', many: 'Assets', title: 'name', blurb: 'A furnace, a car, a mower: anything you maintain.', fields: [
    { k: 'name', l: 'Name', t: 'text', req: true, wide: true },
    { k: 'area', l: 'Area', t: 'select', opts: AREAS },
    { k: 'room', l: 'Room on the map', t: 'room' },
    { k: 'parent', l: 'Installed in / part of', t: 'asset' },
    { k: 'type', l: 'Type', t: 'text', ph: 'Furnace, water heater, sedan' },
    { k: 'make', l: 'Make / model', t: 'text' },
    { k: 'serial', l: 'Serial / VIN', t: 'text' },
    { k: 'year', l: 'Year', t: 'number' },
    { k: 'purchased', l: 'Purchased', t: 'date' },
    { k: 'specs', l: 'Specs', t: 'text', ph: 'Filter size, oil spec, tire size', wide: true },
    { k: 'contact', l: 'Contact', t: 'text', ph: 'Plumber, dealer, warranty line', wide: true },
    { k: 'manual', l: 'Manual URL', t: 'url', wide: true },
    { k: 'notes', l: 'Notes (markdown)', t: 'md', wide: true } ] },
  log: { one: 'Log entry', many: 'Maintenance log', title: 'item', blurb: 'Something you did or had done.', fields: [
    { k: 'item', l: 'What was done', t: 'text', req: true, wide: true },
    { k: 'date', l: 'Date', t: 'date', req: true, def: today },
    { k: 'area', l: 'Area', t: 'select', opts: AREAS },
    { k: 'asset', l: 'Asset', t: 'asset', wide: true },
    { k: 'cost', l: 'Cost ($)', t: 'number' },
    { k: 'doneBy', l: 'Done by', t: 'select', opts: ['Me', 'Contractor', 'Dealer or shop'] },
    { k: 'mileage', l: 'Mileage', t: 'number' },
    { k: 'notes', l: 'Notes (markdown)', t: 'md', wide: true } ] },
  schedule: { one: 'Scheduled task', many: 'Schedule', title: 'task', blurb: 'Recurring upkeep with a next-due date.', fields: [
    { k: 'task', l: 'Task', t: 'text', req: true, wide: true },
    { k: 'area', l: 'Area', t: 'select', opts: AREAS },
    { k: 'asset', l: 'Asset', t: 'asset' },
    { k: 'every', l: 'Every', t: 'number', def: () => 12 },
    { k: 'unit', l: 'Unit', t: 'select', opts: ['months', 'weeks', 'years', 'miles'] },
    { k: 'nextDue', l: 'Next due', t: 'date' },
    { k: 'lastDone', l: 'Last done', t: 'date' },
    { k: 'season', l: 'Season', t: 'select', opts: ['', 'Spring', 'Summer', 'Fall', 'Winter'] },
    { k: 'notes', l: 'Notes', t: 'md', wide: true } ] },
  todos: { one: 'To-do', many: 'To-dos', title: 'name', blurb: 'Open work, big or small.', fields: [
    { k: 'name', l: 'To-do', t: 'text', req: true, wide: true },
    { k: 'status', l: 'Status', t: 'select', opts: ['open', 'doing', 'waiting', 'done'] },
    { k: 'priority', l: 'Priority', t: 'select', opts: ['', 'high', 'medium', 'low'] },
    { k: 'due', l: 'Due', t: 'date' },
    { k: 'area', l: 'Area', t: 'select', opts: [...AREAS, 'Projects'] },
    { k: 'asset', l: 'Asset', t: 'asset', wide: true },
    { k: 'notes', l: 'Notes', t: 'md', wide: true } ] },
  projects: { one: 'Project', many: 'Projects', title: 'name', blurb: 'Where it lives and how it was built.', fields: [
    { k: 'name', l: 'Name', t: 'text', req: true, wide: true },
    { k: 'status', l: 'Status', t: 'select', opts: ['idea', 'active', 'live', 'parked', 'archived'] },
    { k: 'started', l: 'Started', t: 'date' },
    { k: 'liveUrl', l: 'Live URL', t: 'url', wide: true },
    { k: 'repo', l: 'Repo', t: 'url', wide: true },
    { k: 'services', l: 'Services (comma separated)', t: 'text', ph: 'GitHub Pages, Firebase' },
    { k: 'tags', l: 'Tags (comma separated)', t: 'text', ph: 'web, hiking' },
    { k: 'summary', l: 'One-line summary', t: 'text', wide: true },
    { k: 'body', l: 'Notes (markdown)', t: 'md', wide: true } ] },
  pages: { one: 'Page', many: 'Pages', title: 'title', blurb: 'A wiki page. Link to others with [[Title]].', fields: [
    { k: 'title', l: 'Title', t: 'text', req: true, wide: true },
    { k: 'area', l: 'Area', t: 'select', opts: ['', ...AREAS, 'Projects'] },
    { k: 'body', l: 'Body (markdown)', t: 'md', wide: true } ] }
};
const COLLS = Object.keys(SCHEMA);

// ---------------------------------------------------------------- state
const state = { user: null, owner: null, ready: false, route: { view: 'home', id: null }, filters: {}, editing: {} };
const store = Object.fromEntries(COLLS.map(c => [c, {}]));
const list = c => Object.values(store[c]);
const assetName = id => (store.assets[id] || {}).name || '';
const pageBySlug = slug => list('pages').find(p => p.slug === slug);

// ---------------------------------------------------------------- firebase
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
let db;
try { db = initializeFirestore(app, { localCache: persistentLocalCache() }); } catch { db = getFirestore(app); }
const provider = new GoogleAuthProvider();
let unsubs = [];

// All household data lives under one owner's user id; the access list says which accounts may open it.
const dataUid = () => state.owner || state.user.uid;
function userDoc(coll, id) { return doc(db, 'users', dataUid(), coll, id); }

async function save(coll, data) {
  const id = data.id || uid();
  const now = Date.now();
  const clean = { ...data, id, updated: now, created: data.created || now };
  if (coll === 'pages') clean.slug = clean.slug || slugify(clean.title);
  for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
  store[coll][id] = clean; // optimistic
  render();
  try { await setDoc(userDoc(coll, id), clean); }
  catch (e) { toast(`Couldn't save (${e.code || e.message}).`, true); }
  return clean;
}
async function remove(coll, id) {
  delete store[coll][id]; render();
  try { await deleteDoc(userDoc(coll, id)); toast('Deleted'); }
  catch (e) { toast(`Couldn't delete (${e.code || e.message}).`, true); }
}

function subscribeAll() {
  unsubscribeAll();
  unsubs.push(onSnapshot(doc(db, 'users', dataUid(), 'map', 'layout'), snap => { store.map = snap.exists() ? snap.data() : null; render(); }, () => {}));
  let pending = COLLS.length;
  for (const c of COLLS) {
    const u = onSnapshot(collection(db, 'users', dataUid(), c), snap => {
      const next = {};
      snap.forEach(d => { next[d.id] = d.data(); });
      store[c] = next;
      if (pending > 0 && --pending === 0) state.ready = true;
      render();
    }, e => { toast(`Live sync stopped for ${c} (${e.code || e.message}).`, true); });
    unsubs.push(u);
  }
}
function unsubscribeAll() { for (const u of unsubs) u(); unsubs = []; }

async function signIn() {
  const msg = $('#landing-msg'); msg.hidden = true;
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    const code = e && e.code || '';
    if (/popup-blocked|popup-closed|cancelled-popup|operation-not-supported/.test(code)) {
      try { await signInWithRedirect(auth, provider); } catch (e2) { msg.textContent = `Sign-in failed (${e2.code || e2.message}).`; msg.hidden = false; }
    } else { msg.textContent = `Sign-in failed (${code || e.message}).`; msg.hidden = false; }
  }
}

onAuthStateChanged(auth, async user => {
  state.user = user; state.owner = null; state.ready = false;
  for (const c of COLLS) store[c] = {};
  store.map = null;
  unsubscribeAll();
  if (user) {
    // Only accounts on the household list get in; the list is kept outside the app.
    let owner = null;
    try { const snap = await getDoc(doc(db, 'access', String(user.email || '').toLowerCase())); if (snap.exists()) owner = snap.data().owner; }
    catch { owner = user.uid; } // rules without an access list yet: fall back to this account's own data
    if (!owner) {
      await signOut(auth);
      const msg = $('#landing-msg'); msg.textContent = `${user.email || 'That account'} isn't on the household list, so there is nothing to show. Ask the owner to add it.`; msg.hidden = false;
      return;
    }
    state.owner = owner; $('#who').textContent = user.displayName || user.email || ''; subscribeAll();
  }
  render();
});

// ---------------------------------------------------------------- markdown
function md(text) {
  if (!text) return '';
  const linked = String(text).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, target, label) => {
    const slug = slugify(target); const exists = !!pageBySlug(slug);
    return `<a class="wiki${exists ? '' : ' missing'}" href="#/pages/${slug}" data-title="${esc(target.trim())}">${esc(label || target)}</a>`;
  });
  const html = marked.parse(linked, { gfm: true, breaks: true });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

// ---------------------------------------------------------------- routing
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view = 'home', ...rest] = h.split('/');
  return { view: view || 'home', id: rest.length ? decodeURIComponent(rest.join('/')) : null };
}
window.addEventListener('hashchange', () => { state.route = parseHash(); render(); window.scrollTo(0, 0); });
state.route = parseHash();

const NAV = [
  ['home', 'Home', '⌂'], ['map', 'Map', 'M'], ['log', 'Log', 'L'], ['schedule', 'Schedule', 'S'], ['todos', 'To-dos', 'T'],
  ['assets', 'Assets', 'A'], ['projects', 'Projects', 'P'], ['pages', 'Pages', 'W'], ['settings', 'Settings', '⚙']
];

// ---------------------------------------------------------------- render
function render() {
  const appEl = $('#app');
  if (!state.user) { appEl.dataset.state = 'out'; $('#landing').hidden = false; $('#shell').hidden = true; return; }
  if (mapState.drag) { mapState.pendingRender = true; return; } // never re-render mid-drag
  appEl.dataset.state = 'in'; $('#landing').hidden = true; $('#shell').hidden = false;
  renderNav();
  const { view, id } = state.route;
  const views = { home, map, log, schedule, todos, assets, projects, pages, settings };
  const fn = views[view] || home;
  $('#main').innerHTML = fn(id); $('#main').classList.toggle('wide', view === 'map');
  if (view === 'map') bindMap();
  document.title = `${view === 'home' ? 'Home Base' : (SCHEMA[view] ? SCHEMA[view].many : view[0].toUpperCase() + view.slice(1)) + ' · Home Base'}`;
}

function renderNav() {
  const openTodos = list('todos').filter(t => t.status !== 'done').length;
  const dueSoon = list('schedule').filter(s => { const n = daysUntil(s.nextDue); return n != null && n <= 30; }).length;
  $('#nav').innerHTML = NAV.map(([v, label, k]) => {
    const count = v === 'todos' ? openTodos : v === 'schedule' ? dueSoon : 0;
    return `<a href="#/${v === 'home' ? '' : v}" ${state.route.view === v ? 'aria-current="page"' : ''}><span class="k">${k}</span>${label}${count ? `<span class="count">${count}</span>` : ''}</a>`;
  }).join('');
}

const head = (title, { eyebrow = '', actions = '', crumbs = '' } = {}) => `
  ${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}
  <div class="page-head"><div>${eyebrow ? `<span class="eyebrow">${eyebrow}</span>` : ''}<h1>${title}</h1></div><div class="actions">${actions}</div></div>`;
const btn = (label, action, extra = '', cls = 'btn small') => `<button class="${cls}" type="button" data-action="${action}" ${extra}>${label}</button>`;
const chip = (v, cls = '') => v ? `<span class="chip ${cls || String(v).toLowerCase()}">${esc(v)}</span>` : '';
const assetLink = id => id && store.assets[id] ? `<a href="#/assets/${id}">${esc(assetName(id))}</a>` : '';

// ----- home
function home() {
  const sched = list('schedule').filter(s => s.nextDue).sort(by('nextDue'));
  const due = sched.filter(s => daysUntil(s.nextDue) <= 30);
  const overdue = due.filter(s => daysUntil(s.nextDue) < 0).length;
  const todos = list('todos').filter(t => t.status !== 'done').sort((a, b) => (a.due || '9999') > (b.due || '9999') ? 1 : -1).slice(0, 8);
  const recent = list('log').sort(by('date', -1)).slice(0, 6);
  const projects = list('projects').filter(p => ['live', 'active'].includes(p.status)).sort(by('name'));
  const pages = list('pages').sort(by('updated', -1)).slice(0, 5);
  const empty = COLLS.every(c => !list(c).length);
  return `
    ${head('Home Base', { eyebrow: new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), actions: btn('+ Log work', 'new', 'data-coll="log"', 'btn primary small') + btn('+ To-do', 'new', 'data-coll="todos"') })}
    ${empty && state.ready ? `<div class="callout"><p><b>Fresh start.</b> Add starter content to get a typical house schedule, your three current projects and a how-to page, or begin from a blank slate.</p>${btn('Add starter content', 'seed', '', 'btn primary small')}</div>` : ''}
    <div class="tiles">
      <div class="tile ${overdue ? 'warn' : ''}"><div class="n">${overdue}</div><div class="l">overdue</div></div>
      <div class="tile ${due.length - overdue ? 'soon' : ''}"><div class="n">${due.length - overdue}</div><div class="l">due in 30 days</div></div>
      <div class="tile"><div class="n">${list('todos').filter(t => t.status !== 'done').length}</div><div class="l">open to-dos</div></div>
      <div class="tile"><div class="n">${list('log').filter(l => daysUntil(l.date) >= -90).length}</div><div class="l">logged, 90 days</div></div>
    </div>
    <div class="grid">
      <section class="card"><header><h2>Due soon</h2><a class="more" href="#/schedule">all</a></header>
        ${due.length ? `<ul class="rows">${due.map(s => { const [lbl, cls] = dueLabel(s.nextDue); return `<li><a class="t" href="#/schedule/${s.id}">${esc(s.task)}<span class="sub">${esc(assetName(s.asset) || s.area || '')}</span></a><span class="${cls}">${lbl}</span>${btn('Done', 'complete', `data-id="${s.id}"`)}</li>`; }).join('')}</ul>` : `<div class="empty">Nothing due in the next month.</div>`}
      </section>
      <section class="card"><header><h2>Open to-dos</h2><a class="more" href="#/todos">all</a></header>
        ${todos.length ? `<ul class="rows">${todos.map(todoRow).join('')}</ul>` : `<div class="empty">No open to-dos.</div>`}
      </section>
      <section class="card"><header><h2>Recent work</h2><a class="more" href="#/log">all</a></header>
        ${recent.length ? `<ul class="rows">${recent.map(l => `<li><a class="t" href="#/log/${l.id}">${esc(l.item)}<span class="sub">${esc(assetName(l.asset) || l.area || '')}${l.cost ? ' · ' + money(l.cost) : ''}</span></a><span class="m">${fmtDate(l.date)}</span></li>`).join('')}</ul>` : `<div class="empty">No work logged yet.</div>`}
      </section>
      <section class="card"><header><h2>Projects</h2><a class="more" href="#/projects">all</a></header>
        ${projects.length ? `<ul class="rows">${projects.map(p => `<li><a class="t" href="#/projects/${p.id}">${esc(p.name)}<span class="sub">${esc(p.summary || '')}</span></a>${chip(p.status)}${p.liveUrl ? `<a class="m" href="${esc(p.liveUrl)}" target="_blank" rel="noopener">open ↗</a>` : ''}</li>`).join('')}</ul>` : `<div class="empty">No live projects.</div>`}
      </section>
      <section class="card"><header><h2>Recently edited pages</h2><a class="more" href="#/pages">all</a></header>
        ${pages.length ? `<ul class="rows">${pages.map(p => `<li><a class="t" href="#/pages/${p.slug}">${esc(p.title)}</a>${chip(p.area)}<span class="m">${new Date(p.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></li>`).join('')}</ul>` : `<div class="empty">No pages yet. Pages are free-form notes: a house overview, a car's quirks, a contractor list.</div>`}
      </section>
    </div>`;
}

function todoRow(t) {
  const [lbl, cls] = t.due ? dueLabel(t.due) : ['', 'm'];
  return `<li class="${t.status === 'done' ? 'done' : ''}"><input type="checkbox" data-action="toggle-todo" data-id="${t.id}" ${t.status === 'done' ? 'checked' : ''} aria-label="Mark done">
    <a class="t" href="#/todos/${t.id}">${esc(t.name)}<span class="sub">${esc(assetName(t.asset) || t.area || '')}</span></a>${t.priority === 'high' ? chip('high') : ''}${t.status === 'waiting' || t.status === 'doing' ? chip(t.status) : ''}<span class="${cls}">${lbl}</span></li>`;
}

// ----- log
function log(id) {
  if (id) return detail('log', id);
  const f = state.filters.log || {};
  let rows = list('log').sort(by('date', -1));
  if (f.area) rows = rows.filter(r => r.area === f.area);
  if (f.q) rows = rows.filter(r => `${r.item} ${r.notes} ${assetName(r.asset)}`.toLowerCase().includes(f.q.toLowerCase()));
  const total = rows.reduce((a, r) => a + (Number(r.cost) || 0), 0);
  return `
    ${head('Maintenance log', { eyebrow: `${rows.length} entries${total ? ' · ' + money(total) : ''}`, actions: btn('+ Log work', 'new', 'data-coll="log"', 'btn primary small') })}
    ${toolbar('log', f)}
    <div class="card table-wrap">${rows.length ? `<table class="table"><thead><tr><th>Date</th><th>What</th><th>Asset</th><th>By</th><th class="num">Cost</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td class="num">${fmtDate(r.date)}</td><td><a href="#/log/${r.id}">${esc(r.item)}</a>${r.notes ? `<div class="sub" style="color:var(--ink-3);font-size:12.5px">${esc(r.notes.split('\n')[0].slice(0, 90))}</div>` : ''}</td><td>${assetLink(r.asset) || chip(r.area)}</td><td>${esc(r.doneBy || '')}</td><td class="num">${money(r.cost)}</td></tr>`).join('')}
    </tbody></table>` : `<div class="empty">Nothing logged${f.q || f.area ? ' that matches' : ''}. Use “Log work” to add the first entry.</div>`}</div>`;
}

function toolbar(coll, f) {
  const areas = coll === 'todos' ? [...AREAS, 'Projects'] : AREAS;
  return `<div class="toolbar">
    <input type="search" placeholder="Search" value="${esc(f.q || '')}" data-filter="${coll}" data-key="q">
    <div class="seg">${['', ...areas].map(a => `<button type="button" aria-pressed="${(f.area || '') === a}" data-filter="${coll}" data-key="area" data-value="${a}">${a || 'All'}</button>`).join('')}</div>
  </div>`;
}

// ----- schedule
function schedule(id) {
  if (id) return detail('schedule', id);
  const f = state.filters.schedule || {};
  let rows = list('schedule').sort((a, b) => (a.nextDue || '9999') > (b.nextDue || '9999') ? 1 : -1);
  if (f.area) rows = rows.filter(r => r.area === f.area);
  if (f.q) rows = rows.filter(r => `${r.task} ${r.notes} ${assetName(r.asset)}`.toLowerCase().includes(f.q.toLowerCase()));
  return `
    ${head('Schedule', { eyebrow: 'recurring upkeep', actions: btn('+ Scheduled task', 'new', 'data-coll="schedule"', 'btn primary small') })}
    ${toolbar('schedule', f)}
    <div class="card">${rows.length ? `<ul class="rows">${rows.map(s => { const [lbl, cls] = dueLabel(s.nextDue); return `<li><a class="t" href="#/schedule/${s.id}">${esc(s.task)}<span class="sub">${esc(assetName(s.asset) || s.area || '')} · every ${esc(s.every || '')} ${esc(s.unit || 'months')}${s.lastDone ? ' · last ' + fmtDate(s.lastDone) : ''}</span></a><span class="${cls}">${s.unit === 'miles' && !s.nextDue ? 'by mileage' : lbl || 'no date'}</span>${btn('Done', 'complete', `data-id="${s.id}"`)}</li>`; }).join('')}</ul>` : `<div class="empty">No scheduled tasks yet.</div>`}</div>`;
}

// ----- todos
function todos(id) {
  if (id) return detail('todos', id);
  const f = state.filters.todos || {};
  let rows = list('todos');
  if (f.area) rows = rows.filter(r => r.area === f.area);
  if (f.q) rows = rows.filter(r => `${r.name} ${r.notes}`.toLowerCase().includes(f.q.toLowerCase()));
  const open = rows.filter(t => t.status !== 'done').sort((a, b) => (a.due || '9999') > (b.due || '9999') ? 1 : -1);
  const done = rows.filter(t => t.status === 'done').sort(by('updated', -1)).slice(0, 25);
  return `
    ${head('To-dos', { eyebrow: `${open.length} open`, actions: btn('+ To-do', 'new', 'data-coll="todos"', 'btn primary small') })}
    ${toolbar('todos', f)}
    <div class="card">${open.length ? `<ul class="rows">${open.map(todoRow).join('')}</ul>` : `<div class="empty">Nothing open.</div>`}</div>
    ${done.length ? `<div class="section"><h2>Done</h2><div class="card"><ul class="rows">${done.map(todoRow).join('')}</ul></div></div>` : ''}`;
}

// ----- assets
function assets(id) {
  if (id) return assetDetail(id);
  const rows = list('assets').sort(by('name'));
  const groups = {};
  for (const a of rows) (groups[a.area || 'Other'] ||= []).push(a);
  return `
    ${head('Assets', { eyebrow: 'things you maintain', actions: btn('+ Asset', 'new', 'data-coll="assets"', 'btn primary small') })}
    ${rows.length ? `<div class="grid">${Object.entries(groups).map(([area, items]) => `<section class="card"><header><h2>${esc(area)}</h2><span class="more">${items.length}</span></header><ul class="rows">${items.map(a => `<li><a class="t" href="#/assets/${a.id}">${esc(a.name)}<span class="sub">${esc([a.type, a.make].filter(Boolean).join(' · '))}</span></a><span class="m">${esc(a.year || '')}</span></li>`).join('')}</ul></section>`).join('')}</div>`
    : `<div class="card"><div class="empty">No assets yet. Start with the furnace, the water heater and each car. Put the filter size or oil spec in Specs and it's one tap away at the store.<div class="row" style="margin-top:10px">${btn('Add my cars', 'seed-cars', '', 'btn primary small')}</div></div></div>`}`;
}

function assetDetail(id) {
  const a = store.assets[id];
  if (!a) return head('Not found', { crumbs: `<a href="#/assets">Assets</a>` });
  const history = list('log').filter(l => l.asset === id).sort(by('date', -1));
  const sched = list('schedule').filter(s => s.asset === id).sort((x, y) => (x.nextDue || '9999') > (y.nextDue || '9999') ? 1 : -1);
  const open = list('todos').filter(t => t.asset === id && t.status !== 'done');
  const spent = history.reduce((s, l) => s + (Number(l.cost) || 0), 0);
  const room = assetRoom(a); const host = a.parent ? store.assets[a.parent] : null; const inside = parts(id); const carrier = hostOf(a); const carrierRoom = carrier && assetRoom(carrier);
  const props = [['Area', chip(a.area)], ['Installed in', host ? `<a href="#/assets/${host.id}">${esc(host.name)}</a>` : ''], ['Contains', inside.length ? inside.map(c => `<a href="#/assets/${c.id}">${esc(c.name)}</a>`).join(', ') : ''], ['Type', esc(a.type)], ['Make / model', esc(a.make)], ['Serial / VIN', a.serial ? `<code>${esc(a.serial)}</code>` : ''], ['Year', esc(a.year)], ['Purchased', fmtDate(a.purchased)], ['Specs', esc(a.specs)], ['Contact', esc(a.contact)], ['Manual', a.manual ? `<a href="${esc(a.manual)}" target="_blank" rel="noopener">open ↗</a>` : ''], ['On map', a.map && (room || a.map.x != null) ? `<a href="#/map" data-action="map-goto" data-floor="${esc(a.map.floor)}" data-focus="${esc(room ? roomKey(room) : '')}">${esc(room ? room.name : floorName(a.map.floor))}</a>` : carrier ? `<a href="#/map" data-action="map-goto" data-floor="${esc(carrier.map.floor)}" data-focus="${esc(carrierRoom ? roomKey(carrierRoom) : '')}">with ${esc(carrier.name)}${carrierRoom ? ` in ${esc(carrierRoom.name)}` : ''}</a>` : btn('Place on map', 'map-place', `data-id="${id}"`, 'btn small')], ['Spent', spent ? money(spent) : '']].filter(([, v]) => v);
  return `
    ${head(esc(a.name), { crumbs: `<a href="#/assets">Assets</a> / ${esc(a.area || '')}`, actions: btn('+ Log work', 'new', `data-coll="log" data-asset="${id}" data-area="${esc(a.area || '')}"`, 'btn primary small') + btn('+ Schedule', 'new', `data-coll="schedule" data-asset="${id}" data-area="${esc(a.area || '')}"`) + btn('+ To-do', 'new', `data-coll="todos" data-asset="${id}" data-area="${esc(a.area || '')}"`) + btn('Edit', 'edit', `data-coll="assets" data-id="${id}"`) })}
    <div class="detail">
      <div>
        ${a.notes ? `<div class="page-body prose">${md(a.notes)}</div>` : ''}
        <div class="section"><h2>Service history <span class="more" style="font-family:var(--mono);font-size:12px;color:var(--ink-3)">${history.length}</span></h2>
          <div class="card">${history.length ? `<ul class="rows">${history.map(l => `<li><a class="t" href="#/log/${l.id}">${esc(l.item)}<span class="sub">${esc(l.doneBy || '')}${l.mileage ? ' · ' + Number(l.mileage).toLocaleString() + ' mi' : ''}</span></a><span class="m">${money(l.cost)}</span><span class="m">${fmtDate(l.date)}</span></li>`).join('')}</ul>` : `<div class="empty">No work logged for this yet.</div>`}</div></div>
        <div class="section"><h2>Schedule</h2>
          <div class="card">${sched.length ? `<ul class="rows">${sched.map(s => { const [lbl, cls] = dueLabel(s.nextDue); return `<li><a class="t" href="#/schedule/${s.id}">${esc(s.task)}<span class="sub">every ${esc(s.every || '')} ${esc(s.unit || 'months')}</span></a><span class="${cls}">${lbl || 'no date'}</span>${btn('Done', 'complete', `data-id="${s.id}"`)}</li>`; }).join('')}</ul>` : `<div class="empty">Nothing scheduled for this.</div>`}</div></div>
        ${open.length ? `<div class="section"><h2>Open to-dos</h2><div class="card"><ul class="rows">${open.map(todoRow).join('')}</ul></div></div>` : ''}
      </div>
      <aside class="card"><dl class="props">${props.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></aside>
    </div>`;
}

// ----- projects
function projects(id) {
  if (id) return projectDetail(id);
  const rows = list('projects').sort((a, b) => ['live', 'active', 'idea', 'parked', 'archived'].indexOf(a.status) - ['live', 'active', 'idea', 'parked', 'archived'].indexOf(b.status) || (a.name > b.name ? 1 : -1));
  return `
    ${head('Projects', { eyebrow: `${rows.length} projects`, actions: btn('+ Project', 'new', 'data-coll="projects"', 'btn primary small') })}
    ${rows.length ? `<div class="grid">${rows.map(p => `<section class="card"><header><h2><a href="#/projects/${p.id}">${esc(p.name)}</a></h2>${chip(p.status)}</header>
      <div style="padding:12px 16px;font-size:14px;color:var(--ink-2)">${esc(p.summary || '')}</div>
      <div style="padding:0 16px 12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">${p.liveUrl ? `<a class="btn small" href="${esc(p.liveUrl)}" target="_blank" rel="noopener">Open ↗</a>` : ''}${p.repo ? `<a class="btn small ghost" href="${esc(p.repo)}" target="_blank" rel="noopener">Repo</a>` : ''}${(p.tags || '').split(',').map(t => t.trim()).filter(Boolean).map(t => chip(t, 'tag')).join('')}</div></section>`).join('')}</div>`
    : `<div class="card"><div class="empty">No projects yet.</div></div>`}`;
}

function projectDetail(id) {
  const p = store.projects[id];
  if (!p) return head('Not found', { crumbs: `<a href="#/projects">Projects</a>` });
  const props = [['Status', chip(p.status)], ['Started', fmtDate(p.started)], ['Live', p.liveUrl ? `<a href="${esc(p.liveUrl)}" target="_blank" rel="noopener">${esc(p.liveUrl.replace(/^https?:\/\//, ''))}</a>` : ''], ['Repo', p.repo ? `<a href="${esc(p.repo)}" target="_blank" rel="noopener">${esc(p.repo.replace(/^https?:\/\//, ''))}</a>` : ''], ['Services', esc(p.services)], ['Tags', esc(p.tags)]].filter(([, v]) => v);
  return `
    ${head(esc(p.name), { crumbs: `<a href="#/projects">Projects</a>`, actions: (p.liveUrl ? `<a class="btn small" href="${esc(p.liveUrl)}" target="_blank" rel="noopener">Open ↗</a>` : '') + btn('Edit', 'edit', `data-coll="projects" data-id="${id}"`) })}
    <div class="detail">
      <div>${p.summary ? `<p style="font-size:17px;color:var(--ink-2);margin:0 0 16px">${esc(p.summary)}</p>` : ''}
        <div class="page-body prose">${p.body ? md(p.body) : '<p style="color:var(--ink-3)">No notes yet. Edit to add how it was built, what it depends on, and how to update it.</p>'}</div></div>
      <aside class="card"><dl class="props">${props.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></aside>
    </div>`;
}

// ----- pages (wiki)
function pages(slug) {
  if (slug) return pageView(slug);
  const f = state.filters.pages || {};
  let rows = list('pages').sort(by('title'));
  if (f.q) rows = rows.filter(p => `${p.title} ${p.body}`.toLowerCase().includes(f.q.toLowerCase()));
  const groups = {};
  for (const p of rows) (groups[p.area || 'General'] ||= []).push(p);
  return `
    ${head('Pages', { eyebrow: 'the wiki', actions: btn('+ Page', 'new', 'data-coll="pages"', 'btn primary small') })}
    <div class="toolbar"><input type="search" placeholder="Search pages" value="${esc(f.q || '')}" data-filter="pages" data-key="q"></div>
    ${rows.length ? `<div class="grid">${Object.entries(groups).map(([area, items]) => `<section class="card"><header><h2>${esc(area)}</h2><span class="more">${items.length}</span></header><ul class="rows">${items.map(p => `<li><a class="t" href="#/pages/${p.slug}">${esc(p.title)}<span class="sub">${esc((p.body || '').replace(/[#*_\[\]>`]/g, '').split('\n').find(l => l.trim()) || '')}</span></a><span class="m">${new Date(p.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></li>`).join('')}</ul></section>`).join('')}</div>`
    : `<div class="card"><div class="empty">No pages yet. Good first pages: a house overview with shutoff locations, each car's quirks, a list of people you call.</div></div>`}`;
}

function pageView(slug) {
  const p = pageBySlug(slug);
  if (!p) {
    const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return `${head(esc(title), { crumbs: `<a href="#/pages">Pages</a>` })}<div class="callout"><p>This page doesn't exist yet.</p>${btn('Create it', 'new', `data-coll="pages" data-title="${esc(title)}" data-slug="${esc(slug)}"`, 'btn primary small')}</div>`;
  }
  const editing = state.editing.page === p.id;
  const backlinks = list('pages').filter(o => o.id !== p.id && new RegExp(`\\[\\[${p.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]`, 'i').test(o.body || ''));
  return `
    ${head(esc(p.title), { crumbs: `<a href="#/pages">Pages</a>${p.area ? ' / ' + esc(p.area) : ''}`, actions: editing ? '' : btn('Edit', 'edit-page', `data-id="${p.id}"`, 'btn primary small') + btn('Properties', 'edit', `data-coll="pages" data-id="${p.id}"`) })}
    ${editing ? `<div class="md-editor"><textarea id="page-editor" spellcheck="true">${esc(p.body || '')}</textarea>
        <div class="bar">${btn('Save', 'save-page', `data-id="${p.id}"`, 'btn primary small')}${btn('Cancel', 'cancel-page', '', 'btn small')}<span class="hint">Markdown. Link to another page with [[Page title]]. Ctrl+Enter saves.</span></div></div>`
      : `<div class="page-body"><div class="prose">${p.body ? md(p.body) : '<p style="color:var(--ink-3)">Empty page. Click Edit to write it.</p>'}</div>
        <div class="page-meta">Updated ${new Date(p.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}${backlinks.length ? ` · Linked from ${backlinks.map(b => `<a href="#/pages/${b.slug}">${esc(b.title)}</a>`).join(', ')}` : ''}</div></div>`}`;
}

// ----- generic detail for log / schedule / todos
function detail(coll, id) {
  const d = store[coll][id];
  const s = SCHEMA[coll];
  if (!d) return head('Not found', { crumbs: `<a href="#/${coll}">${s.many}</a>` });
  const title = d[s.title];
  const rows = s.fields.filter(f => f.k !== s.title && f.t !== 'md' && d[f.k] !== undefined && d[f.k] !== '' && d[f.k] !== null).map(f => {
    let v = d[f.k];
    if (f.t === 'asset') v = assetLink(v); else if (f.t === 'date') v = fmtDate(v); else if (f.k === 'cost') v = money(v); else if (f.k === 'mileage') v = Number(v).toLocaleString() + ' mi'; else if (f.t === 'select') v = chip(v); else v = esc(v);
    return [f.l, v];
  });
  const notes = d.notes || d.body;
  const extra = coll === 'schedule' ? btn('Mark done today', 'complete', `data-id="${id}"`, 'btn primary small') : coll === 'todos' && d.status !== 'done' ? btn('Mark done', 'toggle-todo', `data-id="${id}"`, 'btn primary small') : '';
  return `
    ${head(esc(title), { crumbs: `<a href="#/${coll}">${s.many}</a>`, actions: extra + btn('Edit', 'edit', `data-coll="${coll}" data-id="${id}"`) })}
    <div class="detail">
      <div>${notes ? `<div class="page-body prose">${md(notes)}</div>` : `<div class="card"><div class="empty">No notes.</div></div>`}</div>
      <aside class="card"><dl class="props">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></aside>
    </div>`;
}

// ----- settings
function settings() {
  const counts = COLLS.map(c => `<li><span class="t">${SCHEMA[c].many}</span><span class="m">${list(c).length}</span></li>`).join('');
  const theme = document.documentElement.dataset.theme || 'system';
  return `
    ${head('Settings', { eyebrow: 'this account' })}
    <div class="grid">
      <section class="card"><header><h2>Appearance</h2></header><div style="padding:14px 16px"><div class="seg">${['system', 'light', 'dark'].map(t => `<button type="button" aria-pressed="${theme === t}" data-action="theme" data-value="${t}">${t}</button>`).join('')}</div></div></section>
      <section class="card"><header><h2>Backup</h2></header><div style="padding:14px 16px;display:grid;gap:10px">
        <p style="margin:0;color:var(--ink-2);font-size:14px">Everything syncs to your account. Export a JSON copy now and then anyway; it restores with Import.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${btn('Export JSON', 'export')}<label class="btn small">Import JSON<input type="file" accept="application/json" data-action="import" hidden></label></div></div></section>
      <section class="card"><header><h2>What's stored</h2></header><ul class="rows">${counts}</ul></section>
      <section class="card"><header><h2>Starter content</h2></header><div style="padding:14px 16px;display:grid;gap:10px"><p style="margin:0;color:var(--ink-2);font-size:14px">Adds a typical house schedule, a how-to page and your current projects. Skips anything with the same name that already exists.</p><div class="row">${btn('Add starter content', 'seed')}${btn('Add my cars', 'seed-cars')}</div></div></section>
      <section class="card"><header><h2>Account</h2></header><div style="padding:14px 16px;font-size:14px;color:var(--ink-2)">Signed in as ${esc(state.user.email || state.user.displayName || '')}. One shared household logbook, readable only by the accounts on its access list.</div></section>
    </div>`;
}

// ---------------------------------------------------------------- map
// Rooms live in one document (map/layout); each asset carries its own map position {floor, x, y}.
const MAP_W = 1200, MAP_H = 800, SNAP = 10;
const mapState = { floor: null, mode: 'view', view: 'iso', selected: null, placing: null, tool: null, drag: null, pendingRender: false, hover: null, cam: null, focus: null };
try { const v = localStorage.getItem('hb.mapview'); if (v === 'plan' || v === 'iso') mapState.view = v; } catch {}
function mapData() {
  const m = store.map || {};
  return { floors: m.floors && m.floors.length ? m.floors : [{ id: 'main', name: 'Main floor' }], rooms: m.rooms || [], doors: m.doors || [], bg: m.bg || {} };
}
function floorName(id) { const f = mapData().floors.find(f => f.id === id); return f ? f.name : ''; }
function roomAt(pos) { return mapData().rooms.find(r => r.floor === pos.floor && pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h) || null; }
// A component is either assigned to a room (map:{floor, room}) and laid out automatically, or pinned by hand (map:{floor, x, y}).
function assetRoom(a) { if (!a || !a.map) return null; if (a.map.room) return mapData().rooms.find(r => r.floor === a.map.floor && roomKey(r) === a.map.room) || null; return a.map.x != null ? roomAt(a.map) : null; }
function roomValue(a) { if (!a || !a.map) return ''; if (a.map.room) return `${a.map.floor}|${a.map.room}`; const r = assetRoom(a); return r ? `${r.floor}|${roomKey(r)}` : ''; }
function roomOptions(cur) {
  const m = mapData(); const seen = new Set(); const opts = [];
  for (const f of m.floors) for (const r of m.rooms.filter(r => r.floor === f.id).sort(by('name'))) { const v = `${f.id}|${roomKey(r)}`; if (seen.has(v)) continue; seen.add(v); opts.push(`<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(r.name)}${r.kind === 'outdoor' ? ' (outdoor)' : ''}${m.floors.length > 1 ? ` · ${esc(f.name)}` : ''}</option>`); }
  return `<option value="">— not on the map —</option>${opts.join('')}`;
}
// Where every component on a floor stands: hand-placed ones as stored; room-assigned ones packed to scale in rows from the back-left
// corner of the room (biggest piece first, biggest things first), the way appliances line a wall and cars fill a drive.
function resolvePlaced(floorId) {
  const m = mapData(); const rooms = m.rooms.filter(r => r.floor === floorId); const groups = roomGroups(rooms);
  const out = [], byRoom = new Map();
  for (const a of list('assets')) {
    if (!a.map || a.map.floor !== floorId || hostOf(a)) continue;
    if (a.map.room) { if (!byRoom.has(a.map.room)) byRoom.set(a.map.room, []); byRoom.get(a.map.room).push(a); }
    else if (a.map.x != null) out.push({ a, shape: assetShape(a, roomAt(a.map)), x: a.map.x, y: a.map.y, auto: false });
  }
  for (const [k, items] of byRoom) {
    const group = groups.get(k);
    if (!group) { items.forEach(a => out.push({ a, shape: assetShape(a), x: null, y: null, auto: true, lost: true })); continue; }
    const pieces = [...group].sort((p, q) => q.w * q.h - p.w * p.h); const gap = 8, pad = 10;
    const queue = items.map(a => ({ a, shape: assetShape(a, pieces[0]) })).sort((p, q) => q.shape.w * q.shape.d - p.shape.w * p.shape.d || String(p.a.name).localeCompare(String(q.a.name)));
    let i = 0;
    for (const r of pieces) {
      let cx = r.x + pad, cy = r.y + pad, rowH = 0;
      while (i < queue.length) {
        const { a, shape } = queue[i];
        if (cx > r.x + pad && cx + shape.w > r.x + r.w - pad) { cx = r.x + pad; cy += rowH + gap; rowH = 0; }
        if (cy > r.y + pad && cy + shape.d > r.y + r.h - pad) break; // this piece is full
        out.push({ a, shape, x: Math.round(cx + shape.w / 2), y: Math.round(cy + shape.d / 2), auto: true });
        cx += shape.w + gap; rowH = Math.max(rowH, shape.d); i++;
      }
      if (i >= queue.length) break;
    }
    for (; i < queue.length; i++) { const r = pieces[0]; out.push({ a: queue[i].a, shape: queue[i].shape, x: Math.round(r.x + r.w / 2 + (i % 3) * 6), y: Math.round(r.y + r.h / 2 + (i % 3) * 6), auto: true, crowded: true }); }
  }
  return out;
}
const WORST = ['over', 'soon', 'todo', 'ok', 'none'];
const shortName = (n, max = 15) => { n = String(n || ''); return n.length > max ? n.slice(0, max - 1).trimEnd() + '…' : n; };
// Per room: how many components and the worst status among them, for the badge under the room name.
function roomSummary(placed, rooms) {
  const out = new Map();
  for (const p of placed) { const r = p.a.map.room ? rooms.find(x => roomKey(x) === p.a.map.room) : roomAt({ floor: p.a.map.floor, x: p.x, y: p.y }); if (!r) continue; const k = roomKey(r); const cls = assetStatusDeep(p.a.id).cls; const cur = out.get(k) || { n: 0, cls: 'none' }; cur.n++; if (WORST.indexOf(cls) < WORST.indexOf(cur.cls)) cur.cls = cls; out.set(k, cur); }
  return out;
}
const onWall = (d, r) => d.dir === 'h' ? (r.y === d.y || r.y + r.h === d.y) && d.x > r.x && d.x < r.x + r.w : (r.x === d.x || r.x + r.w === d.x) && d.y > r.y && d.y < r.y + r.h;
async function saveMap(patch) {
  const m = { ...mapData(), ...patch, id: 'layout', updated: Date.now() };
  if (patch.rooms) m.doors = m.doors.filter(d => m.rooms.some(r => r.floor === d.floor && onWall(d, r)));
  store.map = m; render();
  try { await setDoc(doc(db, 'users', dataUid(), 'map', 'layout'), m); }
  catch (e) { toast(`Couldn't save the map (${e.code || e.message}).`, true); }
}
function assetStatus(id) {
  const items = list('schedule').filter(s => s.asset === id && s.nextDue).sort(by('nextDue'));
  const worst = items.length ? daysUntil(items[0].nextDue) : null;
  const todos = list('todos').filter(t => t.asset === id && t.status !== 'done');
  const last = list('log').filter(l => l.asset === id).sort(by('date', -1))[0] || null;
  const cls = worst == null ? (todos.length ? 'todo' : 'none') : worst < 0 ? 'over' : worst <= 30 ? 'soon' : 'ok';
  const label = cls === 'over' ? `${-worst}d overdue` : cls === 'soon' ? (worst === 0 ? 'due today' : `due in ${worst}d`) : cls === 'ok' ? 'all good' : cls === 'todo' ? `${todos.length} open to-do${todos.length > 1 ? 's' : ''}` : 'nothing scheduled';
  return { cls, worst, todos, items, last, label };
}
// Docking: parts(id) are the assets installed in it; hostOf(a) is the placed asset that carries a docked part on the map; isInside guards against loops.
const parts = id => list('assets').filter(a => a.parent === id).sort(by('name'));
function isInside(a, rootId) { let p = a; for (let i = 0; p && i < 12; i++) { if (p.id === rootId) return true; p = p.parent ? store.assets[p.parent] : null; } return false; }
function hostOf(a) { let p = a && a.parent ? store.assets[a.parent] : null; for (let i = 0; p && !p.map && p.parent && i < 12; i++) p = store.assets[p.parent]; return p && p.map ? p : null; }
// The status of an asset together with everything installed in it: the worst one wins, and the label says which part it came from.
function assetStatusDeep(id) {
  let worst = { ...assetStatus(id), from: null, parts: [] }; const seen = new Set([id]);
  const walk = pid => { for (const c of parts(pid)) { if (seen.has(c.id)) continue; seen.add(c.id); worst.parts.push(c); const st = assetStatus(c.id); if (WORST.indexOf(st.cls) < WORST.indexOf(worst.cls)) worst = { ...worst, ...st, from: c, parts: worst.parts }; walk(c.id); } };
  walk(id); if (worst.from) worst.label = `${worst.from.name}: ${worst.label}`; return worst;
}
const ICONS = [[/furnace|heat pump|boiler|hvac/i, '🔥'], [/water heater/i, '🚿'], [/car|truck|suv|wagon|sedan|subaru|toyota|honda|ford|jeep|tesla/i, '🚗'], [/mower|tractor/i, '🚜'], [/fridge|refrigerator|freezer/i, '🧊'], [/washer|dryer|laundry/i, '🧺'], [/dishwasher/i, '🍽️'], [/range|oven|stove|cooktop/i, '🍳'], [/air cond|\bac\b|mini.?split/i, '❄️'], [/sprinkler|irrigation|hose/i, '💦'], [/roof|chimney/i, '🏠'], [/gutter/i, '🌧️'], [/panel|electric|breaker/i, '⚡'], [/garage door/i, '🚪'], [/sump|pump|well|septic/i, '💧'], [/generator|battery|solar/i, '🔋'], [/tree|garden|lawn/i, '🌳'], [/bike|bicycle/i, '🚲'], [/smoke|detector|alarm/i, '🚨'], [/window|skylight/i, '🪟'], [/deck|fence|shed/i, '🪵'], [/tv|television|oled|qled/i, '📺'], [/router|wifi|network|modem/i, '📡'], [/thermostat/i, '🌡️'], [/fireplace|wood stove/i, '🪵'], [/hot tub|spa|pool/i, '🛁'], [/grill|bbq|smoker/i, '🍖']];
function assetIcon(a) { const t = `${a.name} ${a.type || ''} ${a.make || ''}`; for (const [re, ic] of ICONS) if (re.test(t)) return ic; return a.area === 'Car' ? '🚗' : a.area === 'Yard' ? '🌿' : '🔧'; }
const SCALE = 11; // map units per foot: the garage is 250 units across, about a 23 ft two-car garage
const ft = v => Math.round(v * SCALE);
// What a component is and how big it stands on the map: footprint w (across) x d (deep) x h (tall) in feet, and how it is drawn.
const SHAPES = [
  [/crosstrek|outback|forester|suv|wagon|truck|jeep|4runner|pickup|minivan|van\b/i, { kind: 'car', w: 6, d: 15, h: 5.4, tall: true }],
  [/\bcar\b|sedan|subaru|toyota|honda|ford|tesla|legacy|civic|accord|camry|coupe|hatchback/i, { kind: 'car', w: 6, d: 15.5, h: 4.7 }],
  [/tv|television|oled|qled/i, { kind: 'tv', w: 4.8, d: 0.9, h: 2.9 }],
  [/washer|washing/i, { kind: 'washer', w: 2.3, d: 2.4, h: 3.2 }],
  [/dryer/i, { kind: 'dryer', w: 2.3, d: 2.4, h: 3.2 }],
  [/fridge|refrigerator|freezer/i, { kind: 'fridge', w: 3, d: 2.6, h: 5.8 }],
  [/range|oven|stove|cooktop/i, { kind: 'range', w: 2.5, d: 2.3, h: 3 }],
  [/dishwasher/i, { kind: 'box', w: 2, d: 2, h: 2.9 }],
  [/water heater|tank/i, { kind: 'cyl', w: 1.9, d: 1.9, h: 5 }],
  [/furnace|boiler|hvac|heat pump|air handler/i, { kind: 'box', w: 2.2, d: 2.6, h: 4.6 }],
  [/air cond|condenser|mini.?split|\bac\b/i, { kind: 'fan', w: 3, d: 3, h: 2.6 }],
  [/mower|tractor|snow ?blower/i, { kind: 'box', w: 2.2, d: 5.5, h: 3.2 }],
  [/generator|battery/i, { kind: 'box', w: 2.4, d: 3.5, h: 2 }],
  [/panel|breaker/i, { kind: 'box', w: 1.4, d: 0.6, h: 3.2 }],
  [/bulb|spare|filter|box of|\bbin\b|supplies|parts|kit/i, { kind: 'bin', w: 1.6, d: 1.6, h: 1.2 }],
];
function assetShape(a, room = null) {
  const t = `${a.name} ${a.type || ''} ${a.make || ''}`; let sh = null; for (const [re, x] of SHAPES) if (re.test(t)) { sh = x; break; }
  if (!sh) sh = a.area === 'Car' ? SHAPES[1][1] : { kind: 'box', w: 2.2, d: 2.2, h: 2.4 };
  // facing: the way the nose points (n = toward the back of the map, s = toward the viewer, e, w); parked outdoors a car faces the house
  const facing = (a.map && a.map.facing) || (room && room.kind === 'outdoor' ? 'n' : 's'); const across = facing === 'e' || facing === 'w';
  return { ...sh, w: ft(across ? sh.d : sh.w), d: ft(across ? sh.w : sh.d), h: ft(sh.h), facing, icon: assetIcon(a) };
}

// Rooms with the same name on a floor join into one shape: shared color, no wall along their seams, one label.
const roomKey = r => (r.name || '').trim().toLowerCase();
function roomGroups(rooms) { const g = new Map(); for (const r of rooms) { const k = roomKey(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); } return g; }
function groupStyle(group) { const main = [...group].sort((a, b) => b.w * b.h - a.w * a.h)[0]; return { main, color: main.color ?? 0 }; }
// The exterior edges of one rectangle: each side is cut where sibling rectangles start or end, and pieces that face into a sibling are dropped.
function roomEdges(r, group, doors = [], cutters = null) {
  const others = group.filter(o => o.id !== r.id); const cutAt = (cutters || others).filter(o => o.id !== r.id);
  const inside = (x, y) => others.some(o => x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h);
  const sides = [['top', r.x, r.y, r.x + r.w, r.y, 0, -1], ['right', r.x + r.w, r.y, r.x + r.w, r.y + r.h, 1, 0], ['bottom', r.x, r.y + r.h, r.x + r.w, r.y + r.h, 0, 1], ['left', r.x, r.y, r.x, r.y + r.h, -1, 0]];
  const edges = [];
  for (const [side, x0, y0, x1, y1, nx, ny] of sides) {
    const horiz = y0 === y1, lo = horiz ? x0 : y0, hi = horiz ? x1 : y1;
    const cuts = [...new Set([lo, hi, ...cutAt.flatMap(o => horiz ? [o.x, o.x + o.w] : [o.y, o.y + o.h]).filter(v => v > lo && v < hi)])].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i], b = cuts[i + 1], mid = (a + b) / 2;
      if (inside((horiz ? mid : x0) + nx * 0.5, (horiz ? y0 : mid) + ny * 0.5)) continue;
      // carve out any door that sits on this stretch of wall
      const gaps = doors.filter(d => horiz ? d.dir === 'h' && d.y === y0 && d.x - d.w / 2 < b && d.x + d.w / 2 > a : d.dir === 'v' && d.x === x0 && d.y - d.w / 2 < b && d.y + d.w / 2 > a)
        .map(d => [Math.max(a, (horiz ? d.x : d.y) - d.w / 2), Math.min(b, (horiz ? d.x : d.y) + d.w / 2)]).sort((p, q) => p[0] - q[0]);
      let cur = a;
      for (const [g0, g1] of gaps) { if (g0 > cur) edges.push(horiz ? { side, x0: cur, y0, x1: g0, y1: y0 } : { side, x0, y0: cur, x1: x0, y1: g0 }); cur = Math.max(cur, g1); }
      if (cur < b) edges.push(horiz ? { side, x0: cur, y0, x1: b, y1: y0 } : { side, x0, y0: cur, x1: x0, y1: b });
    }
  }
  return edges;
}

// Traced from the robot-vacuum map of the house (Nov 2026), plus the garage off the living room by the front door. Same-named pieces join.
const HOUSE_LAYOUT = [
  ['Study', 50, 30, 170, 100, 2], ['Guest Bath', 220, 40, 70, 90, 0], ['Hallway', 190, 130, 100, 40, 4], ['Hallway', 190, 170, 50, 130, 4],
  ['Guest Bedroom', 50, 130, 140, 170, 3], ['Primary Bedroom', 290, 100, 170, 150, 0], ['Guest Bedroom 2', 460, 60, 110, 110, 3], ['Primary Bath', 330, 250, 140, 90, 1],
  ['Living Room', 170, 300, 160, 220, 5], ['Living Room', 330, 340, 370, 260, 5], ['Garage', 700, 340, 240, 260, 1]];
const HOUSE_DOORS = [[205, 130, 'h', 30], [255, 130, 'h', 36], [290, 150, 'v', 36], [190, 230, 'v', 36], [215, 300, 'h', 50], [360, 250, 'h', 36], [460, 135, 'v', 36], [700, 560, 'v', 36], [660, 600, 'h', 36], [820, 600, 'h', 120]];
async function loadHouseLayout() {
  const m = mapData(); const here = m.rooms.filter(r => r.floor === mapState.floor);
  if (here.length && !confirm(`Replace the ${here.length} room${here.length > 1 ? 's' : ''} on ${floorName(mapState.floor)} with the traced house layout? Components keep their positions.`)) return;
  const rooms = [...m.rooms.filter(r => r.floor !== mapState.floor), ...HOUSE_LAYOUT.map(([name, x, y, w, h, color]) => ({ id: uid(), floor: mapState.floor, name, x, y, w, h, color }))];
  const doors = [...m.doors.filter(d => d.floor !== mapState.floor), ...HOUSE_DOORS.map(([x, y, dir, w]) => ({ id: uid(), floor: mapState.floor, x, y, dir, w }))];
  mapState.selected = null; await saveMap({ rooms, doors }); toast('House layout loaded');
}

function map() {
  const m = mapData();
  if (!mapState.floor || !m.floors.some(f => f.id === mapState.floor)) mapState.floor = m.floors[0].id;
  const floor = m.floors.find(f => f.id === mapState.floor);
  const rooms = m.rooms.filter(r => r.floor === floor.id);
  const doors = m.doors.filter(d => d.floor === floor.id);
  const entries = resolvePlaced(floor.id); const placed = entries.filter(p => !p.lost); placed.forEach((p, i) => { p.n = i + 1; });
  const unplaced = list('assets').filter(a => !hostOf(a) && (!a.map || entries.some(p => p.lost && p.a.id === a.id))).sort(by('name'));
  const summary = roomSummary(placed, rooms);
  const edit = mapState.mode === 'edit';
  const sel = edit && mapState.selected ? m.rooms.find(r => r.id === mapState.selected) : null;
  const placingAsset = mapState.placing ? store.assets[mapState.placing] : null;

  const groups = roomGroups(rooms);
  const roomsSvg = rooms.map(r => {
    const group = groups.get(roomKey(r)); const { main, color } = groupStyle(group);
    return `<g class="room t${color} ${sel && sel.id === r.id ? 'sel' : ''}" data-room="${r.id}">
      <rect class="floor ${r.kind === 'outdoor' ? 'outdoor' : ''}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>
      <path class="wall ${r.kind === 'outdoor' ? 'curb' : ''}" d="${roomEdges(r, group, doors).map(e => `M${e.x0} ${e.y0}L${e.x1} ${e.y1}`).join('')}"/>
      ${main.id === r.id ? `<text class="room-label" x="${r.x + r.w / 2}" y="${r.y + 24}" text-anchor="middle" data-focus="${esc(roomKey(r))}">${esc(r.name.toUpperCase())}</text>${badge(summary.get(roomKey(r)), r.x + r.w / 2, r.y + 32)}` : ''}
      ${edit ? `<rect class="handle" data-handle="${r.id}" x="${r.x + r.w - 14}" y="${r.y + r.h - 14}" width="14" height="14" rx="3"/>` : ''}
    </g>`; }).join('');
  // plan doors: a sill across the gap, and for a hinged door its leaf and swing arc
  const doorsSvg = doors.map(d => {
    const h = d.dir === 'h', hw = d.w / 2, x0 = h ? d.x - hw : d.x, y0 = h ? d.y : d.y - hw, x1 = h ? d.x + hw : d.x, y1 = h ? d.y : d.y + hw;
    const leaf = d.w >= 80 ? '' : h ? `<path class="swing" d="M${x0} ${y0 + d.w}A${d.w} ${d.w} 0 0 0 ${x1} ${y0}"/><line class="leaf" x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + d.w}"/>` : `<path class="swing" d="M${x0 + d.w} ${y0}A${d.w} ${d.w} 0 0 1 ${x0} ${y1}"/><line class="leaf" x1="${x0}" y1="${y0}" x2="${x0 + d.w}" y2="${y0}"/>`;
    return `<g class="door" data-door="${d.id}"><line class="sill" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>${leaf}${edit ? `<rect class="hit" x="${d.x - hw - 6}" y="${d.y - hw - 6}" width="${d.w + 12}" height="${d.w + 12}"/>` : ''}</g>`; }).join('');
  const markersSvg = placed.map(({ a, x, y, auto, n, shape }) => { const st = assetStatusDeep(a.id); const { w, d } = shape; const gs = Math.max(11, Math.min(26, Math.min(w, d) * 0.6)); return `<g class="marker ${st.cls} ${auto ? 'auto' : ''}" data-asset="${a.id}" data-x="${x}" data-y="${y}" transform="translate(${x},${y})">
      <rect class="foot" x="${-w / 2}" y="${-d / 2}" width="${w}" height="${d}" rx="3"/>
      <text class="glyph" y="${gs * 0.36}" text-anchor="middle" font-size="${gs}">${assetIcon(a)}</text>
      <g class="num"><circle cx="${w / 2}" cy="${-d / 2}" r="9"/><text x="${w / 2}" y="${-d / 2 + 3.5}" text-anchor="middle">${n}</text></g>
      <text class="mlabel" y="${d / 2 + 14}" text-anchor="middle">${esc(shortName(a.name, 20).toUpperCase())}${st.parts.length ? ` +${st.parts.length}` : ''}</text>
    </g>`; }).join('');
  const bg = m.bg[floor.id] ? `<image href="${m.bg[floor.id]}" x="0" y="0" width="${MAP_W}" height="${MAP_H}" preserveAspectRatio="xMidYMid meet" class="bgimg"/>` : '';
  const iso = !edit && mapState.view === 'iso';

  const floorTabs = `<div class="seg">${m.floors.map(f => `<button type="button" aria-pressed="${f.id === floor.id}" data-action="map-floor" data-id="${f.id}">${esc(f.name)}</button>`).join('')}</div>`;
  const viewTabs = edit ? '' : `<div class="seg"><button type="button" aria-pressed="${iso}" data-action="map-view" data-value="iso">3D</button><button type="button" aria-pressed="${!iso}" data-action="map-view" data-value="plan">Plan</button></div>`;
  const statusRows = placed.map(({ a, n }) => ({ a, n, st: assetStatusDeep(a.id) }));
  const worstRow = statusRows.slice().sort((x, y) => WORST.indexOf(x.st.cls) - WORST.indexOf(y.st.cls))[0];

  const panel = edit ? `
      <section class="card"><header><h2>Editing ${esc(floor.name)}</h2></header>
        <div class="map-panel">
          <p class="hint">${mapState.tool ? `<b>Click a wall</b> to add a ${mapState.tool === 'wide' ? 'wide opening' : 'door'}. Click a door to remove it. Esc to stop.` : 'Drag on empty space to draw a room. Drag a room to move it, its corner to resize. Drag a component to pin it to a spot. Click a door to remove it.'}</p>
          <div class="row">${btn(mapState.tool === 'door' ? 'Placing doors…' : '+ Door', 'map-tool', 'data-value="door"', mapState.tool === 'door' ? 'btn small primary' : 'btn small')}${btn(mapState.tool === 'wide' ? 'Placing openings…' : '+ Wide opening', 'map-tool', 'data-value="wide"', mapState.tool === 'wide' ? 'btn small primary' : 'btn small')}</div>
          <label class="field"><span>Floor name</span><input type="text" value="${esc(floor.name)}" data-map="floor-name"></label>
          <div class="row">${btn('+ Floor', 'map-add-floor')}${btn('Load traced house', 'map-load-house')}${m.floors.length > 1 && !rooms.length && !placed.length ? btn('Delete floor', 'map-del-floor', '', 'btn small danger') : ''}</div>
          <label class="field"><span>Floor plan image (optional)</span><span class="row">${m.bg[floor.id] ? btn('Remove image', 'map-bg-remove', '', 'btn small') : ''}<label class="btn small">Upload<input type="file" accept="image/*" data-action="map-bg" hidden></label></span></label>
        </div>
      </section>
      ${sel ? `<section class="card"><header><h2>Room</h2></header><div class="map-panel">
          <label class="field"><span>Name</span><input type="text" id="room-name" value="${esc(sel.name)}" data-map="room-name"></label>
          <div class="swatches">${[0, 1, 2, 3, 4, 5].map(i => `<button type="button" class="swatch t${i} ${groupStyle(roomGroups(rooms).get(roomKey(sel)) || [sel]).color === i ? 'on' : ''}" data-action="map-room-color" data-value="${i}" aria-label="Color ${i + 1}"></button>`).join('')}</div>
          <p class="hint">${(roomGroups(rooms).get(roomKey(sel)) || []).length > 1 ? `One of ${roomGroups(rooms).get(roomKey(sel)).length} pieces of ${esc(sel.name)}. ` : ''}Pieces with the same name join into one room, for L-shapes.${sel.kind === 'outdoor' ? ' Outdoor: paved ground with no walls, like a driveway or patio.' : ''}</p>
          <div class="row">${btn(sel.kind === 'outdoor' ? 'Make it a room' : 'Make it outdoor', 'map-room-kind', `data-value="${sel.kind === 'outdoor' ? '' : 'outdoor'}"`)}${btn('Delete piece', 'map-del-room', '', 'btn small danger')}</div></div></section>` : ''}
      <section class="card"><header><h2>Place components</h2><span class="more">${unplaced.length}</span></header>
        ${placingAsset ? `<div class="callout callout-box small"><p>Click on the map to place <b>${esc(placingAsset.name)}</b>.</p>${btn('Cancel', 'map-place-cancel')}</div>` : ''}
        ${unplaced.length ? `<ul class="rows">${unplaced.map(a => `<li><span class="t">${assetIcon(a)} ${esc(a.name)}<span class="sub">${esc(a.area || '')}</span></span><span class="row"><select class="mini" data-map="place-room" data-id="${a.id}" aria-label="Room for ${esc(a.name)}"><option value="">Room…</option>${roomOptions('').replace(/^<option[^>]*>[^<]*<\/option>/, '')}</select>${btn('Pin', 'map-place', `data-id="${a.id}"`, 'btn small ghost')}</span></li>`).join('')}</ul>` : `<div class="empty">Every asset is on the map. Add more under Assets.</div>`}
      </section>
      ${placed.length ? `<section class="card"><header><h2>On this floor</h2></header><ul class="rows">${placed.map(p => p.a).sort(by('name')).map(a => `<li><span class="t">${assetIcon(a)} ${esc(a.name)}<span class="sub">${a.map.room ? esc((assetRoom(a) || {}).name || '') : 'pinned'}</span></span>${btn('Unplace', 'map-unplace', `data-id="${a.id}"`, 'btn small ghost')}</li>`).join('')}</ul></section>` : ''}`
    : `
      <section class="card"><header><h2>Status</h2>${worstRow && worstRow.st.cls !== 'none' ? `<span class="more">${esc(worstRow.st.label)}: ${esc(worstRow.a.name)}</span>` : ''}</header>
        <ul class="legend"><li><i class="over"></i>Overdue</li><li><i class="soon"></i>Due within 30 days</li><li><i class="todo"></i>Open to-do</li><li><i class="ok"></i>All good</li><li><i class="none"></i>Nothing scheduled</li></ul>
      </section>
      <section class="card"><header><h2>On ${esc(floor.name)}</h2><span class="more">${placed.length}</span></header>
        ${statusRows.length ? `<ul class="rows keyed">${statusRows.map(({ a, n, st }) => `<li data-hl="${a.id}"><span class="key">${n}</span><a class="t" href="#/assets/${a.id}">${assetIcon(a)} ${esc(a.name)}<span class="sub">${esc((assetRoom(a) || {}).name || 'pinned')} · ${esc(st.label)}</span></a><i class="dot ${st.cls}"></i></li>${st.parts.map(c => `<li class="part" data-hl="${a.id}"><span class="key dim">↳</span><a class="t" href="#/assets/${c.id}">${assetIcon(c)} ${esc(c.name)}<span class="sub">in ${esc(a.name)} · ${esc(assetStatus(c.id).label)}</span></a><i class="dot ${assetStatus(c.id).cls}"></i></li>`).join('')}`).join('')}</ul>` : `<div class="empty">Nothing on this floor yet. Give an asset a room (edit the asset, or Edit layout here) and it appears.</div>`}
      </section>
      <section class="card"><header><h2>Reading the drawing</h2></header><div class="map-panel"><p class="hint">Scroll or pinch to zoom, drag to pan. Click a room name to zoom into it, double-click empty ground to zoom out. Numbers on the plinths match the list; hover one for its status, click to open it.</p></div></section>`;

  // the plan fits the rooms when just looking; editing shows the whole canvas so there is room to draw
  const pb = edit || !rooms.length ? [0, 0, MAP_W, MAP_H] : (() => { const x0 = Math.max(0, Math.min(...rooms.map(r => r.x)) - 40), y0 = Math.max(0, Math.min(...rooms.map(r => r.y)) - 40); return [x0, y0, Math.min(MAP_W, Math.max(...rooms.map(r => r.x + r.w)) + 40) - x0, Math.min(MAP_H, Math.max(...rooms.map(r => r.y + r.h)) + 40) - y0]; })();
  const planSvg = `<svg id="map-svg" viewBox="${pb.join(' ')}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="House map">
          <defs><pattern id="grid" width="${SNAP * 5}" height="${SNAP * 5}" patternUnits="userSpaceOnUse"><path d="M ${SNAP * 5} 0 L 0 0 0 ${SNAP * 5}" class="gridline"/></pattern></defs>
          <rect width="${MAP_W}" height="${MAP_H}" class="ground"/>${bg}<rect width="${MAP_W}" height="${MAP_H}" fill="url(#grid)" class="gridfill"/>
          <g id="rooms">${roomsSvg}</g><g id="doors">${doorsSvg}</g><g id="markers">${markersSvg}</g><g id="scratch"></g>
        </svg>`;

  return `
    ${head('Map', { eyebrow: `${new Set(m.rooms.map(r => `${r.floor}|${roomKey(r)}`)).size} rooms · ${list('assets').filter(a => a.map || hostOf(a)).length} of ${list('assets').length} components placed`, actions: floorTabs + viewTabs + (edit ? btn('Done editing', 'map-mode', 'data-value="view"', 'btn primary small') : btn('Edit layout', 'map-mode', 'data-value="edit"', 'btn small')) })}
    ${!rooms.length && !edit ? `<div class="callout"><p><b>No rooms on ${esc(floor.name)} yet.</b> Draw a few rooms, or upload a floor plan image as the background, then place components. Rough is fine; this is a stage, not a survey.</p><div class="row">${btn('Load my house', 'map-load-house', '', 'btn primary small')}${btn('Edit layout', 'map-mode', 'data-value="edit"', 'btn small')}</div></div>` : ''}
    <div class="map-layout">
      <div class="map-wrap ${edit ? 'edit' : ''} ${placingAsset || mapState.tool ? 'placing' : ''} ${iso ? 'iso' : 'plan'} ${placed.length > 8 ? 'busy' : ''}">
        ${iso ? isoSvg(rooms, doors, placed, m.bg[floor.id], summary) : planSvg}
        <div class="map-tip" id="map-tip" hidden></div>
        <button type="button" class="btn small map-reset" data-action="map-reset" hidden>Whole floor</button>
        <div class="sheet-title"><b>${esc(floor.name)}</b><span>${new Set(rooms.map(roomKey)).size} rooms · ${placed.length} component${placed.length === 1 ? '' : 's'}${doors.length ? ` · ${doors.length} doors` : ''}</span><span>${edit ? 'Editing layout' : iso ? 'Isometric · 30°' : 'Plan'} · Home Base</span></div>
      </div>
      <aside class="map-side">${panel}</aside>
    </div>`;
}

// Count badge next to a room name, colored by the worst status inside.
function badge(sum, x, y, anchor = 'middle') { if (!sum) return ''; const w = sum.n > 9 ? 36 : 28; const bx = anchor === 'start' ? x : x - w / 2; return `<g class="chip ${sum.cls}"><rect x="${bx}" y="${y}" width="${w}" height="20" rx="10"/><text x="${bx + w / 2}" y="${y + 14.5}" text-anchor="middle">${sum.n}</text></g>`; }

// Isometric view: the plan projected at 30° and built like an architect's model on a blueprint sheet. Exterior walls at the back stand full
// height; every other wall is cut low (a section cut) so each room stays open. Walls are solid boxes, the floor is a slab, doors swing.
const ISO_H = 64, ISO_L = 22, ISO_CHUNK = 40, SLAB = 10, WALL_EXT = 10, WALL_INT = 6;
const isoP = (x, y, z = 0) => ({ X: (x - y) * 0.866, Y: (x + y) * 0.5 - z });
const f1 = n => n.toFixed(1);
const isoPts = arr => arr.map(p => `${f1(p.X)},${f1(p.Y)}`).join(' ');
// A solid box from z=0 up to h: its top and the two faces that face the camera (+x on the right, +y on the left).
const isoBox = (x0, y0, x1, y1, h, cls = '', z0 = 0) => `<g class="box ${cls}"><polygon class="fy" points="${isoPts([isoP(x0, y1, z0), isoP(x1, y1, z0), isoP(x1, y1, z0 + h), isoP(x0, y1, z0 + h)])}"/><polygon class="fx" points="${isoPts([isoP(x1, y0, z0), isoP(x1, y1, z0), isoP(x1, y1, z0 + h), isoP(x1, y0, z0 + h)])}"/><polygon class="ft" points="${isoPts([isoP(x0, y0, z0 + h), isoP(x1, y0, z0 + h), isoP(x1, y1, z0 + h), isoP(x0, y1, z0 + h)])}"/></g>`;
// Every wall piece on a floor, cut wherever any room starts or ends and with door gaps carved; exterior when no room lies on its other side.
function wallPieces(rooms, doors) {
  const groups = roomGroups(rooms); const out = [];
  for (const r of rooms) for (const e of roomEdges(r, groups.get(roomKey(r)), doors, rooms)) {
    const horiz = e.y0 === e.y1, mx = (e.x0 + e.x1) / 2, my = (e.y0 + e.y1) / 2;
    const nx = horiz ? 0 : e.side === 'left' ? -1 : 1, ny = horiz ? (e.side === 'top' ? -1 : 1) : 0;
    const ext = !rooms.some(o => o.id !== r.id && mx + nx > o.x && mx + nx < o.x + o.w && my + ny > o.y && my + ny < o.y + o.h);
    const back = e.side === 'top' || e.side === 'left';
    out.push({ ...e, horiz, room: r, ext, h: ext && back ? ISO_H : ISO_L, t: ext ? WALL_EXT : WALL_INT });
  }
  return out;
}
const wallAt = (pieces, d) => pieces.find(p => p.horiz ? d.dir === 'h' && p.y0 === d.y && d.x >= p.x0 - d.w && d.x <= p.x1 + d.w : d.dir === 'v' && p.x0 === d.x && d.y >= p.y0 - d.w && d.y <= p.y1 + d.w);
// Floors and slab first, then walls, door leaves and components sorted by depth, labels and callouts on top.
function isoSvg(rooms, doors, placed, bgData, summary = new Map()) {
  const xs = [...rooms.flatMap(r => [r.x, r.x + r.w]), ...placed.map(p => p.x)], ys = [...rooms.flatMap(r => [r.y, r.y + r.h]), ...placed.map(p => p.y)];
  const has = xs.length > 0;
  const gx0 = has ? Math.min(...xs) - 140 : 0, gy0 = has ? Math.min(...ys) - 140 : 0, gx1 = has ? Math.max(...xs) + 140 : MAP_W, gy1 = has ? Math.max(...ys) + 140 : MAP_H;
  const all = [];
  for (const r of rooms) all.push(isoP(r.x, r.y, ISO_H), isoP(r.x + r.w, r.y, ISO_H), isoP(r.x, r.y + r.h, -SLAB - 16), isoP(r.x + r.w, r.y + r.h, -SLAB - 16), isoP(r.x + r.w, r.y), isoP(r.x, r.y + r.h));
  const indoor = rooms.filter(r => r.kind !== 'outdoor');
  const baseZ = p => { const r = p.a.map.room ? rooms.find(x => roomKey(x) === p.a.map.room) : roomAt({ floor: p.a.map.floor, x: p.x, y: p.y }); return r && r.kind === 'outdoor' ? -SLAB : 0; };
  for (const p of placed) { p.z0 = baseZ(p); const { w, d, h } = p.shape; all.push(isoP(p.x - w / 2, p.y + d / 2, p.z0 - 6), isoP(p.x + w / 2, p.y + d / 2, p.z0 - 6), isoP(p.x + w / 2, p.y - d / 2, p.z0 + h)); const T = isoP(p.x, p.y, p.z0 + h + 160); all.push(T, { X: T.X + 36 + shortName(p.a.name, 20).length * 9.2, Y: T.Y }); }
  if (!all.length) all.push(isoP(gx0, gy0), isoP(gx1, gy0), isoP(gx1, gy1), isoP(gx0, gy1));
  const minX = Math.min(...all.map(p => p.X)) - 36, maxX = Math.max(...all.map(p => p.X)) + 36, minY = Math.min(...all.map(p => p.Y)) - 36, maxY = Math.max(...all.map(p => p.Y)) + 36;

  const groups = roomGroups(rooms); const pieces = wallPieces(indoor, doors);
  const shadows = [], slab = [], floors = [], ground = [], flat = [], ents = [], labels = [];
  const taken = []; const free = r => !taken.some(t => r.x0 < t.x1 + 14 && r.x1 > t.x0 - 14 && r.y0 < t.y1 + 6 && r.y1 > t.y0 - 6);
  const claim = (cands, box) => { const hit = cands.find(c => free(box(c))) || cands[0]; taken.push(box(hit)); return hit; };
  for (const r of rooms) {
    const group = groups.get(roomKey(r)); const { color } = groupStyle(group); const cls = `room t${color}`;
    if (r.kind === 'outdoor') { ground.push(`<g class="${cls}" data-room="${r.id}"><polygon class="floor outdoor" points="${isoPts([isoP(r.x, r.y, -SLAB), isoP(r.x + r.w, r.y, -SLAB), isoP(r.x + r.w, r.y + r.h, -SLAB), isoP(r.x, r.y + r.h, -SLAB)])}"/></g>`); continue; }
    shadows.push(`<polygon points="${isoPts([isoP(r.x, r.y, -SLAB - 14), isoP(r.x + r.w, r.y, -SLAB - 14), isoP(r.x + r.w, r.y + r.h, -SLAB - 14), isoP(r.x, r.y + r.h, -SLAB - 14)])}"/>`);
    floors.push(`<g class="${cls}" data-room="${r.id}"><polygon class="floor" points="${isoPts([isoP(r.x, r.y), isoP(r.x + r.w, r.y), isoP(r.x + r.w, r.y + r.h), isoP(r.x, r.y + r.h)])}"/></g>`);
  }
  // room names: biggest rooms claim their spot first; a name tries the back of its room, then the middle, then the front
  for (const r of rooms.filter(r => groupStyle(groups.get(roomKey(r))).main.id === r.id).sort((a, b) => b.w * b.h - a.w * a.h)) {
    const name = r.name.toUpperCase(); const w = name.length * 14.1; const sum = summary.get(roomKey(r)); const full = w + (sum ? 36 : 0);
    const cx = r.x + r.w / 2, zr = r.kind === 'outdoor' ? -SLAB : 0; const spots = [[cx, r.y + 26], [cx, r.y + r.h / 2], [cx, r.y + r.h - 22], [cx, r.y + Math.min(r.h - 22, 70)]]; if (r.kind === 'outdoor') spots.splice(0, 4, spots[2], spots[1], spots[0]); // paved areas are named at the front, where the cars are not
    const cands = spots.map(([x, y]) => isoP(x, y, zr));
    const L = claim(cands, c => ({ x0: c.X - full / 2, x1: c.X + full / 2, y0: c.Y - 12, y1: c.Y + 16 }));
    const bx = L.X - full / 2;
    labels.push(`<g class="rlabel ${r.kind === 'outdoor' ? 'outdoor' : ''}" data-focus="${esc(roomKey(r))}"><text class="room-label" x="${f1(bx)}" y="${f1(L.Y + 6)}">${esc(name)}</text><line class="rule" x1="${f1(bx)}" y1="${f1(L.Y + 14)}" x2="${f1(bx + w)}" y2="${f1(L.Y + 14)}"/>${badge(sum, bx + w + 8, L.Y - 10, 'start')}</g>`);
  }
  for (const p of pieces) {
    if (p.ext && (p.side === 'bottom' || p.side === 'right')) slab.push(`<polygon class="${p.side === 'bottom' ? 'fy' : 'fx'}" points="${isoPts(p.side === 'bottom' ? [isoP(p.x0, p.y1), isoP(p.x1, p.y1), isoP(p.x1, p.y1, -SLAB), isoP(p.x0, p.y1, -SLAB)] : [isoP(p.x1, p.y0), isoP(p.x1, p.y1), isoP(p.x1, p.y1, -SLAB), isoP(p.x1, p.y0, -SLAB)])}"/>`);
    const lo = p.horiz ? p.x0 : p.y0, hi = p.horiz ? p.x1 : p.y1, ht = p.t / 2;
    for (let a = lo; a < hi; a += ISO_CHUNK) {
      const b = Math.min(hi, a + ISO_CHUNK), a2 = a === lo ? a - ht : a - 0.6, b2 = b === hi ? b + ht : b + 0.6;
      const box = p.horiz ? [a2, p.y0 - ht, b2, p.y0 + ht] : [p.x0 - ht, a2, p.x0 + ht, b2];
      ents.push({ d: (box[0] + box[2]) / 2 + (box[1] + box[3]) / 2, k: 0, html: `<g class="wall ${p.ext ? 'ext' : 'int'}" data-room="${p.room.id}">${isoBox(...box, p.h)}</g>` });
    }
  }
  for (const d of doors) { const { floor, leaf, depth } = isoDoor(d, wallAt(pieces, d)); flat.push(floor); if (leaf) ents.push({ d: depth, k: 0.5, html: leaf }); }
  // callouts: back to front, each takes the lowest height above its object whose label does not cover another label
  for (const p of placed.slice().sort((a, b) => a.x + a.y - b.x - b.y)) {
    const w = (shortName(p.a.name, 20).length + (parts(p.a.id).length ? 3 : 0)) * 9.2 + 34;
    p.up = claim([40, 68, 96, 124, 152, 180], up => { const T = isoP(p.x, p.y, p.z0 + p.shape.h + up); return { x0: T.X - 10, x1: T.X - 10 + w, y0: T.Y - 12, y1: T.Y + 12 }; });
  }
  for (const p of placed) { const m = isoObject(p); ents.push({ d: p.x + p.y, k: 1, html: m.body }); labels.push(m.callout); }
  ents.sort((p, q) => p.d - q.d || p.k - q.k);
  return `<svg id="map-svg" viewBox="${minX.toFixed(0)} ${minY.toFixed(0)} ${(maxX - minX).toFixed(0)} ${(maxY - minY).toFixed(0)}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="House map, isometric">
      <defs>
        <pattern id="grid" width="${SNAP * 5}" height="${SNAP * 5}" patternUnits="userSpaceOnUse"><path d="M ${SNAP * 5} 0 L 0 0 0 ${SNAP * 5}" class="gridline"/></pattern>
        <pattern id="grid2" width="${SNAP * 10}" height="${SNAP * 10}" patternUnits="userSpaceOnUse"><path d="M ${SNAP * 10} 0 L 0 0 0 ${SNAP * 10}" class="gridline major"/></pattern>
        <radialGradient id="fade"><stop offset="35%" stop-color="#fff"/><stop offset="100%" stop-color="#000"/></radialGradient>
        <mask id="gmask"><rect x="${gx0}" y="${gy0}" width="${gx1 - gx0}" height="${gy1 - gy0}" fill="url(#fade)"/></mask>
        <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
      </defs>
      <g transform="matrix(0.866,0.5,-0.866,0.5,0,0)" mask="url(#gmask)">
        ${bgData ? `<image href="${bgData}" x="0" y="0" width="${MAP_W}" height="${MAP_H}" preserveAspectRatio="xMidYMid meet" class="bgimg"/>` : ''}
        <rect x="${gx0}" y="${gy0}" width="${gx1 - gx0}" height="${gy1 - gy0}" fill="url(#grid)"/><rect x="${gx0}" y="${gy0}" width="${gx1 - gx0}" height="${gy1 - gy0}" fill="url(#grid2)"/>
      </g>
      ${ground.join('')}<g class="shadow" filter="url(#soft)">${shadows.join('')}</g>
      <g class="slab">${slab.join('')}</g>
      ${floors.join('')}${flat.join('')}${ents.map(e => e.html).join('')}${labels.join('')}
    </svg>`;
}
// A door: its swing arc drawn on the floor, a threshold across the gap, and (unless it is a wide opening) a leaf standing open at one jamb.
function isoDoor(d, wall) {
  const h = d.dir === 'h', hw = d.w / 2, H = wall ? wall.h : ISO_L, wide = d.w >= 80;
  const sill = h ? [isoP(d.x - hw, d.y - 3), isoP(d.x + hw, d.y - 3), isoP(d.x + hw, d.y + 3), isoP(d.x - hw, d.y + 3)] : [isoP(d.x - 3, d.y - hw), isoP(d.x + 3, d.y - hw), isoP(d.x + 3, d.y + hw), isoP(d.x - 3, d.y + hw)];
  const jx = h ? d.x - hw : d.x, jy = h ? d.y : d.y - hw;
  // the swing arc, drawn in plan space inside the transformed group
  const arc = wide ? '' : h ? `M${jx} ${jy + d.w}A${d.w} ${d.w} 0 0 0 ${jx + d.w} ${jy}L${jx} ${jy}Z` : `M${jx + d.w} ${jy}A${d.w} ${d.w} 0 0 1 ${jx} ${jy + d.w}L${jx} ${jy}Z`;
  const floor = `<g class="door iso" data-door="${d.id}"><g transform="matrix(0.866,0.5,-0.866,0.5,0,0)">${arc ? `<path class="swing" d="${arc}"/>` : ''}</g><polygon class="sill" points="${isoPts(sill)}"/></g>`;
  if (wide) return { floor, leaf: '', depth: 0 };
  const leaf = h ? isoBox(jx - 1.5, jy, jx + 1.5, jy + d.w, H, 'leaf') : isoBox(jx, jy - 1.5, jx + d.w, jy + 1.5, H, 'leaf');
  return { floor, leaf: `<g class="door iso" data-door="${d.id}">${leaf}</g>`, depth: h ? jx + jy + d.w / 2 : jx + d.w / 2 + jy };
}
// A car built in its own frame (u across, v along the body, nose at +v), turned to face shape.facing. Faces are drawn only when they look toward the camera.
function carModel(shape, cx, cy, z0) {
  const across = shape.facing === 'e' || shape.facing === 'w'; const w = across ? shape.d : shape.w, d = across ? shape.w : shape.d, h = shape.h, tall = shape.tall;
  const clear = ft(0.8), roof = clear + ft(2.2), ins = w * 0.1, wr = ft(1.05);
  const u0 = -w / 2, u1 = w / 2, v0 = -d / 2, v1 = d / 2; const faces = [];
  const box = (a0, b0, a1, b1, zA, zB, cls) => { faces.push({ cls, n: [0, 0, 1], pts: [[a0, b0, zB], [a1, b0, zB], [a1, b1, zB], [a0, b1, zB]] }, { cls, n: [1, 0, 0], pts: [[a1, b0, zA], [a1, b1, zA], [a1, b1, zB], [a1, b0, zB]] }, { cls, n: [-1, 0, 0], pts: [[a0, b0, zA], [a0, b1, zA], [a0, b1, zB], [a0, b0, zB]] }, { cls, n: [0, 1, 0], pts: [[a0, b1, zA], [a1, b1, zA], [a1, b1, zB], [a0, b1, zB]] }, { cls, n: [0, -1, 0], pts: [[a0, b0, zA], [a1, b0, zA], [a1, b0, zB], [a0, b0, zB]] }); };
  box(u0, v0, u1, v1, clear, roof, 'body');
  for (const side of [-1, 1]) for (const vv of [v0 + d * 0.2, v1 - d * 0.2]) { const pts = []; for (let i = 0; i < 16; i++) { const t = i / 16 * Math.PI * 2; pts.push([side * (w / 2 + 1), vv + wr * Math.cos(t), wr + wr * Math.sin(t)]); } faces.push({ cls: 'wheel', n: [side, 0, 0], pts }); }
  const c0 = u0 + ins, c1 = u1 - ins, cv0 = v0 + (tall ? d * 0.1 : d * 0.24), cv1 = v1 - d * 0.3, rake = d * 0.1, back = tall ? d * 0.04 : d * 0.08;
  faces.push({ cls: 'cabin', n: [1, 0, 0], pts: [[c1, cv0, roof], [c1, cv1, roof], [c1, cv1 - rake, h], [c1, cv0 + back, h]] }, { cls: 'cabin', n: [-1, 0, 0], pts: [[c0, cv0, roof], [c0, cv1, roof], [c0, cv1 - rake, h], [c0, cv0 + back, h]] },
    { cls: 'cabin', n: [0, 1, 0], pts: [[c0, cv1, roof], [c1, cv1, roof], [c1, cv1 - rake, h], [c0, cv1 - rake, h]] }, { cls: 'cabin', n: [0, -1, 0], pts: [[c0, cv0, roof], [c1, cv0, roof], [c1, cv0 + back, h], [c0, cv0 + back, h]] },
    { cls: 'cabin roof', n: [0, 0, 1], pts: [[c0, cv0 + back, h], [c1, cv0 + back, h], [c1, cv1 - rake, h], [c0, cv1 - rake, h]] });
  for (const hu of [u0 + w * 0.12, u1 - w * 0.12]) { const lo = clear + ft(1.1), hi = clear + ft(1.6), r = w * 0.09; faces.push({ cls: 'lamp', n: [0, 1, 0], pts: [[hu - r, v1 + 0.5, lo], [hu + r, v1 + 0.5, lo], [hu + r, v1 + 0.5, hi], [hu - r, v1 + 0.5, hi]] }, { cls: 'tail', n: [0, -1, 0], pts: [[hu - r, v0 - 0.5, lo], [hu + r, v0 - 0.5, lo], [hu + r, v0 - 0.5, hi], [hu - r, v0 - 0.5, hi]] }); }
  const turn = { s: (u, v) => [u, v], n: (u, v) => [-u, -v], e: (u, v) => [v, -u], w: (u, v) => [-v, u] }[shape.facing] || ((u, v) => [u, v]);
  let out = '';
  for (const f of faces) {
    const [nx, ny] = turn(f.n[0], f.n[1]); const nz = f.n[2];
    if (!(nz > 0 || nx + ny > 0)) continue;
    const shade = nz > 0 ? 'ft' : nx > 0 ? 'fx' : 'fy';
    out += `<polygon class="${f.cls} ${shade}" points="${isoPts(f.pts.map(([u, v, z]) => { const [dx, dy] = turn(u, v); return isoP(cx + dx, cy + dy, z0 + z); }))}"/>`;
  }
  return out;
}
// Draw one component as a small model to scale, standing at (x, y) with its base at height z0: a car, an appliance, a tank, or a plain crate with its glyph.
function isoObject({ a, x, y, auto, n, shape, up = 40, z0 = 0 }) {
  const st = assetStatusDeep(a.id); const { kind, w, d, h } = shape;
  const x0 = x - w / 2, x1 = x + w / 2, y0 = y - d / 2, y1 = y + d / 2;
  const B = (bx0, by0, bx1, by1, bz0, bz1, cls) => isoBox(bx0, by0, bx1, by1, bz1 - bz0, cls, z0 + bz0);
  // a circle lying flat (plane z), or standing on a face that looks along +y or +x
  const ring = (cx, cy, r, z, cls, plane = 'z') => { const pts = []; for (let i = 0; i < 16; i++) { const t = i / 16 * Math.PI * 2, c = Math.cos(t), s = Math.sin(t); pts.push(plane === 'z' ? isoP(cx + r * c, cy + r * s, z0 + z) : plane === 'y' ? isoP(cx + r * c, cy, z0 + z + r * s) : isoP(cx, cy + r * c, z0 + z + r * s)); } return `<polygon class="${cls}" points="${isoPts(pts)}"/>`; };
  const cyl = (cx, cy, r, hh, cls) => { const N = 14; let out = ''; const top = []; for (let i = 0; i < N; i++) { const t0 = i / N * 2 * Math.PI, t1 = (i + 1) / N * 2 * Math.PI; const nx = Math.cos((t0 + t1) / 2), ny = Math.sin((t0 + t1) / 2); top.push(isoP(cx + r * Math.cos(t0), cy + r * Math.sin(t0), z0 + hh)); if (nx + ny > 0) { const p0 = [cx + r * Math.cos(t0), cy + r * Math.sin(t0)], p1 = [cx + r * Math.cos(t1), cy + r * Math.sin(t1)]; out += `<polygon style="fill:color-mix(in srgb, var(--model-x) ${Math.round((nx + 1) * 50)}%, var(--model-y))" points="${isoPts([isoP(p0[0], p0[1], z0), isoP(p1[0], p1[1], z0), isoP(p1[0], p1[1], z0 + hh), isoP(p0[0], p0[1], z0 + hh)])}"/>`; } } return `<g class="${cls}">${out}<polygon class="ft" points="${isoPts(top)}"/></g>`; };
  const glyph = (size, z) => { const G = isoP(x, y, z0 + z); return `<text class="glyph" x="${f1(G.X)}" y="${f1(G.Y + size * 0.36)}" text-anchor="middle" font-size="${size}">${shape.icon}</text>`; };
  let parts = '';
  if (kind === 'car') parts += carModel(shape, x, y, z0);
  else if (kind === 'washer' || kind === 'dryer') {
    parts += B(x0, y0, x1, y1, 0, h, 'appliance') + B(x0, y0, x1, y0 + d * 0.2, h, h + ft(0.3), 'strip') + ring(x, y1 + 0.5, w * (kind === 'washer' ? 0.3 : 0.26), h * 0.45, 'port', 'y');
  } else if (kind === 'fridge') {
    const z = z0 + h * 0.64; const L = isoP(x0, y1 + 0.5, z), R = isoP(x1, y1 + 0.5, z);
    parts += B(x0, y0, x1, y1, 0, h, 'appliance') + `<line class="seam" x1="${f1(L.X)}" y1="${f1(L.Y)}" x2="${f1(R.X)}" y2="${f1(R.Y)}"/>`;
  } else if (kind === 'range') {
    parts += B(x0, y0, x1, y1, 0, h, 'appliance'); for (const [dx, dy] of [[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]]) parts += ring(x + dx * w, y + dy * d, w * 0.13, h + 0.5, 'burner');
  } else if (kind === 'tv') { parts += B(x - w * 0.18, y0, x + w * 0.18, y1, 0, ft(0.25), 'strip') + B(x0, y + d * 0.3, x1, y1, ft(0.25), h, 'screen'); }
  else if (kind === 'cyl') { parts += cyl(x, y, w / 2, h, 'tank'); }
  else if (kind === 'fan') { parts += B(x0, y0, x1, y1, 0, h, 'appliance') + ring(x, y, w * 0.36, h + 0.5, 'burner'); }
  else { parts += B(x0, y0, x1, y1, 0, h, 'crate') + glyph(Math.max(11, Math.min(30, Math.min(w, d) * 0.6)), h); }
  const pad = isoPts([isoP(x0 - 4, y0 - 4, z0), isoP(x1 + 4, y0 - 4, z0), isoP(x1 + 4, y1 + 4, z0), isoP(x0 - 4, y1 + 4, z0)]);
  const N = isoP(x1, y0, z0 + h); const Tp = isoP(x, y, z0 + h), T = isoP(x, y, z0 + h + up);
  const name = shortName(a.name, 20).toUpperCase() + (st.parts.length ? ` +${st.parts.length}` : ''); const cw = name.length * 9.2 + 34;
  const body = `<g class="marker obj iso ${st.cls} ${auto ? 'auto' : ''}" data-asset="${a.id}" data-x="${x}" data-y="${y}">
      <polygon class="pad" points="${pad}"/>${parts}
      <g class="num"><circle cx="${f1(N.X + 9)}" cy="${f1(N.Y - 9)}" r="10"/><text x="${f1(N.X + 9)}" y="${f1(N.Y - 5)}" text-anchor="middle">${n || ''}</text></g>
    </g>`;
  const callout = `<g class="callout ${st.cls}" data-asset="${a.id}" data-x="${x}" data-y="${y}">
      <line class="leader" x1="${f1(Tp.X)}" y1="${f1(Tp.Y)}" x2="${f1(T.X - 10)}" y2="${f1(T.Y)}"/>
      <g class="ctext"><rect class="cbg" x="${f1(T.X - 10)}" y="${f1(T.Y - 12)}" width="${f1(cw)}" height="24" rx="5"/>
      <circle class="cdot" cx="${f1(T.X + 2)}" cy="${f1(T.Y)}" r="4.5"/>
      <text class="clabel" x="${f1(T.X + 13)}" y="${f1(T.Y + 4.5)}">${esc(name)}</text></g>
    </g>`;
  return { body, callout };
}

function tipHtml(id) {
  const a = store.assets[id]; if (!a) return '';
  const st = assetStatusDeep(id);
  const next = st.items.slice(0, 3).map(s => { const [lbl, cls] = dueLabel(s.nextDue); return `<li><span>${esc(s.task)}</span><span class="${cls.replace('m ', '')}">${lbl}</span></li>`; }).join('');
  return `<div class="tip-head"><span class="glyph">${assetIcon(a)}</span><div><b>${esc(a.name)}</b><div class="sub">${esc([a.type, a.make].filter(Boolean).join(' · '))}</div></div><i class="dot ${st.cls}"></i></div>
    <div class="tip-status ${st.cls}">${esc(st.label)}</div>
    ${next ? `<ul class="tip-list">${next}</ul>` : ''}
    ${st.parts.length ? `<div class="tip-line">Inside: ${esc(st.parts.map(c => c.name).join(', '))}</div>` : ''}
    ${st.todos.length ? `<div class="tip-line">${st.todos.length} open to-do${st.todos.length > 1 ? 's' : ''}: ${esc(st.todos.slice(0, 2).map(t => t.name).join(', '))}</div>` : ''}
    ${st.last ? `<div class="tip-line">Last: ${esc(st.last.item)} · ${fmtDate(st.last.date)}</div>` : '<div class="tip-line">No work logged yet</div>'}
    ${a.specs ? `<div class="tip-line mono">${esc(a.specs)}</div>` : ''}
    <div class="tip-foot">Click to open</div>`;
}

function bindMap() {
  const svg = $('#map-svg'); if (!svg) return;
  const wrap = svg.parentElement; const tip = $('#map-tip');
  bindCamera(svg, wrap);
  const pt = e => { const r = svg.getBoundingClientRect(); return { x: (e.clientX - r.left) * MAP_W / r.width, y: (e.clientY - r.top) * MAP_H / r.height }; };
  const snap = v => Math.round(v / SNAP) * SNAP;
  const clamp = (v, max) => Math.max(0, Math.min(max, v));
  const room = id => mapData().rooms.find(r => r.id === id);

  function showTip(id, e) {
    if (!id || mapState.mode === 'edit') { tip.hidden = true; return; }
    if (tip.dataset.id !== id) { tip.innerHTML = tipHtml(id); tip.dataset.id = id; }
    tip.hidden = false;
    const r = wrap.getBoundingClientRect(); let x = e.clientX - r.left + 16, y = e.clientY - r.top + 16;
    if (x + tip.offsetWidth > r.width - 8) x = e.clientX - r.left - tip.offsetWidth - 16;
    if (y + tip.offsetHeight > r.height - 8) y = Math.max(8, r.height - tip.offsetHeight - 8);
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }

  svg.addEventListener('pointermove', e => {
    const p = pt(e); const d = mapState.drag;
    if (d) {
      const dx = snap(p.x - d.start.x), dy = snap(p.y - d.start.y);
      if (d.type === 'room') d.el.setAttribute('transform', `translate(${dx},${dy})`);
      else if (d.type === 'asset') d.el.setAttribute('transform', `translate(${clamp(snap(d.orig.x + dx), MAP_W)},${clamp(snap(d.orig.y + dy), MAP_H)})`);
      else if (d.type === 'resize') { const w = Math.max(40, d.orig.w + dx), h = Math.max(40, d.orig.h + dy); d.el.querySelectorAll('rect.floor, rect.wall').forEach(r => { r.setAttribute('width', w); r.setAttribute('height', h); }); const pw = d.el.querySelector('path.wall'); if (pw) pw.setAttribute('d', `M${d.orig.x} ${d.orig.y}h${w}v${h}h${-w}z`); const sh = d.el.querySelector('rect.sheen'); if (sh) { sh.setAttribute('width', Math.max(0, w - 6)); sh.setAttribute('height', Math.max(0, h - 6)); } const hd = d.el.querySelector('.handle'); hd.setAttribute('x', d.orig.x + w - 14); hd.setAttribute('y', d.orig.y + h - 14); }
      else if (d.type === 'draw') { const x = Math.min(d.start.x, p.x), y = Math.min(d.start.y, p.y); d.rect.setAttribute('x', snap(x)); d.rect.setAttribute('y', snap(y)); d.rect.setAttribute('width', Math.abs(snap(p.x) - snap(d.start.x))); d.rect.setAttribute('height', Math.abs(snap(p.y) - snap(d.start.y))); }
      return;
    }
    const g = e.target.closest('[data-asset]'); const hid = g ? g.dataset.asset : null;
    if (hid !== mapState.hover) { svg.querySelectorAll('.hov').forEach(m => m.classList.remove('hov')); if (hid) svg.querySelectorAll(`[data-asset="${hid}"]`).forEach(m => m.classList.add('hov')); mapState.hover = hid; }
    showTip(hid, e);
  });
  svg.addEventListener('pointerleave', () => { if (!mapState.drag) tip.hidden = true; svg.querySelectorAll('.hov').forEach(m => m.classList.remove('hov')); mapState.hover = null; });

  svg.addEventListener('pointerdown', e => {
    if (mapState.mode !== 'edit' || e.button !== 0) return;
    const p = pt(e);
    if (mapState.placing) {
      const a = store.assets[mapState.placing]; mapState.placing = null;
      if (a) save('assets', { ...a, map: { floor: mapState.floor, x: clamp(snap(p.x), MAP_W), y: clamp(snap(p.y), MAP_H) } });
      toast(`${a ? a.name : 'Component'} placed`); return;
    }
    const door = e.target.closest('[data-door]');
    if (door) { saveMap({ doors: mapData().doors.filter(d => d.id !== door.dataset.door) }); toast('Door removed'); return; }
    if (mapState.tool) { placeDoor(p, mapState.tool === 'wide' ? 120 : 36); return; }
    const handle = e.target.closest('[data-handle]'), marker = e.target.closest('[data-asset]'), rm = e.target.closest('[data-room]');
    e.preventDefault(); try { svg.setPointerCapture(e.pointerId); } catch {}
    if (handle) mapState.drag = { type: 'resize', id: handle.dataset.handle, start: p, orig: { ...room(handle.dataset.handle) }, el: handle.closest('g') };
    else if (marker) mapState.drag = { type: 'asset', id: marker.dataset.asset, start: p, orig: { x: Number(marker.dataset.x), y: Number(marker.dataset.y) }, el: marker };
    else if (rm) { mapState.selected = rm.dataset.room; mapState.drag = { type: 'room', id: rm.dataset.room, start: p, orig: { ...room(rm.dataset.room) }, el: rm }; }
    else { const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); rect.setAttribute('class', 'drawing'); rect.setAttribute('rx', '8'); $('#scratch').append(rect); mapState.selected = null; mapState.drag = { type: 'draw', start: p, rect }; }
  });

  svg.addEventListener('pointerup', async e => {
    const d = mapState.drag; if (!d) return;
    mapState.drag = null;
    const p = pt(e); const dx = snap(p.x - d.start.x), dy = snap(p.y - d.start.y);
    const m = mapData();
    if (d.type === 'room') { if (dx || dy) { const rooms = m.rooms.map(r => r.id === d.id ? { ...r, x: clamp(r.x + dx, MAP_W - r.w), y: clamp(r.y + dy, MAP_H - r.h) } : r); await saveMap({ rooms }); } else render(); }
    else if (d.type === 'resize') { const rooms = m.rooms.map(r => r.id === d.id ? { ...r, w: Math.max(40, d.orig.w + dx), h: Math.max(40, d.orig.h + dy) } : r); await saveMap({ rooms }); }
    else if (d.type === 'asset') { const a = store.assets[d.id]; const pos = { floor: mapState.floor, x: clamp(snap(d.orig.x + dx), MAP_W), y: clamp(snap(d.orig.y + dy), MAP_H) }; if (dx || dy || a.map.room) await save('assets', { ...a, map: pos }); else render(); }
    else if (d.type === 'draw') {
      d.rect.remove();
      const x = snap(Math.min(d.start.x, p.x)), y = snap(Math.min(d.start.y, p.y)), w = Math.abs(snap(p.x) - snap(d.start.x)), h = Math.abs(snap(p.y) - snap(d.start.y));
      if (w >= 40 && h >= 40) { const r = { id: uid(), floor: mapState.floor, name: 'New room', x, y, w, h, color: m.rooms.length % 6 }; mapState.selected = r.id; saveMap({ rooms: [...m.rooms, r] }); const inp = $('#room-name'); if (inp) { inp.focus(); inp.select(); } }
      else render();
    }
    if (mapState.pendingRender) { mapState.pendingRender = false; render(); }
  });

  svg.addEventListener('click', e => {
    if (mapState.mode !== 'view' || mapState.panned) return;
    const target = e.target === svg ? document.elementFromPoint(e.clientX, e.clientY) || e.target : e.target; // in case the pointer was captured
    const f = target.closest('[data-focus]'); if (f) { focusRoom(svg, wrap, f.dataset.focus); return; }
    const g = target.closest('[data-asset]'); if (g) location.hash = `#/assets/${g.dataset.asset}`;
  });
  svg.addEventListener('dblclick', e => { if (mapState.mode !== 'view') return; const rm = e.target.closest('[data-room]'); const r = rm && mapData().rooms.find(x => x.id === rm.dataset.room); if (r) focusRoom(svg, wrap, roomKey(r)); else setCam(svg, wrap, null); });
  if (mapState.focus) { const k = mapState.focus; mapState.focus = null; focusRoom(svg, wrap, k, false); }
  // hovering a row in the side list lights its marker
  wrap.parentElement.addEventListener('pointerover', e => { const li = e.target.closest('[data-hl]'); svg.querySelectorAll('.lit').forEach(m => m.classList.remove('lit')); if (li) svg.querySelectorAll(`[data-asset="${li.dataset.hl}"]`).forEach(mk => mk.classList.add('lit')); });
}

// ---- camera: the SVG viewBox is the camera. Zoom around the cursor (wheel or pinch), drag to pan, click a room name to frame it.
const vbOf = svg => { const v = svg.viewBox.baseVal; return { x: v.x, y: v.y, w: v.width, h: v.height }; };
function setCam(svg, wrap, cam, animate = true) {
  const base = mapState.base;
  if (cam) { // keep the zoom between 1x and 8x and the view over the floor
    const w = Math.min(base.w, Math.max(base.w / 8, cam.w)), h = w * base.h / base.w;
    cam = { x: Math.min(Math.max(cam.x, base.x - w * 0.25), base.x + base.w - w * 0.75), y: Math.min(Math.max(cam.y, base.y - h * 0.25), base.y + base.h - h * 0.75), w, h };
    if (w >= base.w - 0.5) cam = null;
  }
  const target = cam || base; const from = vbOf(svg);
  mapState.cam = cam ? { ...cam, floor: mapState.floor, view: mapState.view } : null;
  wrap.classList.toggle('zoomed', !!cam && base.w / target.w >= 1.8);
  const box = svg.getBoundingClientRect(); const ppu = Math.min(box.width / target.w, box.height / target.h) || 1; // screen pixels per map unit
  wrap.style.setProperty('--lscale', Math.min(1, 1.1 / ppu).toFixed(3)); // labels keep a readable size on screen as the camera comes closer
  wrap.querySelector('.map-reset').hidden = !cam;
  const apply = v => svg.setAttribute('viewBox', `${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.w.toFixed(1)} ${v.h.toFixed(1)}`);
  if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(target); return; }
  const t0 = performance.now(); cancelAnimationFrame(mapState.anim);
  const step = now => { const t = Math.min(1, (now - t0) / 240), e = 1 - Math.pow(1 - t, 3); apply({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e }); if (t < 1) mapState.anim = requestAnimationFrame(step); };
  mapState.anim = requestAnimationFrame(step);
}
function focusRoom(svg, wrap, key, animate = true) {
  const pieces = mapData().rooms.filter(r => r.floor === mapState.floor && roomKey(r) === key); if (!pieces.length) return;
  const pts = [];
  for (const r of pieces) { const zr = r.kind === 'outdoor' ? -SLAB : 0; const cs = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]; for (const [x, y] of cs) { if (mapState.view === 'iso') { pts.push(isoP(x, y, zr - 6)); pts.push(isoP(x, y, zr + 110)); } else pts.push({ X: x, Y: y }); } }
  const x0 = Math.min(...pts.map(p => p.X)) - 40, x1 = Math.max(...pts.map(p => p.X)) + 40, y0 = Math.min(...pts.map(p => p.Y)) - 30, y1 = Math.max(...pts.map(p => p.Y)) + 50;
  const base = mapState.base; let w = x1 - x0, h = y1 - y0;
  if (w / h < base.w / base.h) w = h * base.w / base.h; else h = w * base.h / base.w;
  setCam(svg, wrap, { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h }, animate);
}
function bindCamera(svg, wrap) {
  mapState.base = vbOf(svg);
  const cam = mapState.cam; if (cam && cam.floor === mapState.floor && cam.view === mapState.view && mapState.mode === 'view') setCam(svg, wrap, cam, false); else { mapState.cam = null; wrap.querySelector('.map-reset').hidden = true; }
  const unit = () => { const r = svg.getBoundingClientRect(); return vbOf(svg).w / r.width; }; // svg units per screen pixel
  const zoomAt = (clientX, clientY, factor) => { const r = svg.getBoundingClientRect(); const v = vbOf(svg); const px = (clientX - r.left) / r.width, py = (clientY - r.top) / r.height; const w = v.w / factor, h = v.h / factor; setCam(svg, wrap, { x: v.x + (v.w - w) * px, y: v.y + (v.h - h) * py, w, h }, false); };
  svg.addEventListener('wheel', e => { if (mapState.mode !== 'view') return; e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016)); }, { passive: false });
  const pointers = new Map(); let pan = null, pinch = null;
  svg.addEventListener('pointerdown', e => {
    if (mapState.mode !== 'view' || e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); // capture only once a pan really starts, or a plain click would be retargeted to the svg
    mapState.panned = false;
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) }; pan = null; }
    else pan = { x: e.clientX, y: e.clientY, v: vbOf(svg) };
  });
  svg.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const grab = () => { for (const id of pointers.keys()) try { svg.setPointerCapture(id); } catch {} };
    if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (d > 0 && pinch.d > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.d); pinch.d = d; if (!mapState.panned) grab(); mapState.panned = true; return; }
    if (!pan) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y; if (!mapState.panned && Math.hypot(dx, dy) < 4) return;
    if (!mapState.panned) grab(); mapState.panned = true; wrap.classList.add('panning'); const u = unit();
    if (mapState.cam || vbOf(svg).w < mapState.base.w) setCam(svg, wrap, { x: pan.v.x - dx * u, y: pan.v.y - dy * u, w: pan.v.w, h: pan.v.h }, false);
  });
  const end = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) { pan = null; wrap.classList.remove('panning'); setTimeout(() => { mapState.panned = false; }, 0); } };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
}

// Put a door on the nearest wall to the click, centered on the click and kept inside that stretch of wall.
function placeDoor(p, w) {
  const m = mapData(); const rooms = m.rooms.filter(r => r.floor === mapState.floor && r.kind !== 'outdoor'); const groups = roomGroups(rooms);
  let best = null;
  for (const r of rooms) for (const e of roomEdges(r, groups.get(roomKey(r)))) {
    const horiz = e.y0 === e.y1, len = horiz ? e.x1 - e.x0 : e.y1 - e.y0; if (len < w) continue;
    const t = horiz ? Math.min(Math.max(p.x, e.x0), e.x1) : Math.min(Math.max(p.y, e.y0), e.y1);
    const dist = horiz ? Math.hypot(p.x - t, p.y - e.y0) : Math.hypot(p.x - e.x0, p.y - t);
    if (dist <= 16 && (!best || dist < best.dist)) best = { dist, e, horiz, t };
  }
  if (!best) { toast('Click closer to a wall'); return; }
  const { e, horiz } = best; const lo = (horiz ? e.x0 : e.y0) + w / 2, hi = (horiz ? e.x1 : e.y1) - w / 2;
  const c = Math.min(Math.max(Math.round(best.t / SNAP) * SNAP, lo), hi);
  const d = { id: uid(), floor: mapState.floor, x: horiz ? c : e.x0, y: horiz ? e.y0 : c, dir: horiz ? 'h' : 'v', w };
  saveMap({ doors: [...m.doors, d] });
}

async function mapBackground(file) {
  const img = new Image(); const url = URL.createObjectURL(file);
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const scale = Math.min(1, 1600 / img.width, 1100 / img.height);
  const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
  let q = 0.82, data = c.toDataURL('image/jpeg', q);
  while (data.length > 850000 && q > 0.4) { q -= 0.1; data = c.toDataURL('image/jpeg', q); }
  if (data.length > 850000) { toast('That image is too large even after shrinking. Try a cropped version.', true); return; }
  await saveMap({ bg: { ...mapData().bg, [mapState.floor]: data } });
  toast('Floor plan added');
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action^="map-"]'); if (!el) return;
  const a = el.dataset.action; const m = mapData();
  if (a === 'map-mode') { mapState.mode = el.dataset.value; mapState.selected = null; mapState.placing = null; mapState.tool = null; mapState.cam = null; render(); }
  else if (a === 'map-reset') { setCam($('#map-svg'), el.parentElement, null); }
  else if (a === 'map-tool') { mapState.tool = mapState.tool === el.dataset.value ? null : el.dataset.value; mapState.placing = null; render(); }
  else if (a === 'map-view') { mapState.view = el.dataset.value; mapState.cam = null; try { localStorage.setItem('hb.mapview', mapState.view); } catch {} render(); }
  else if (a === 'map-floor') { mapState.floor = el.dataset.id; mapState.selected = null; mapState.cam = null; render(); }
  else if (a === 'map-goto') { mapState.floor = el.dataset.floor; mapState.mode = 'view'; mapState.cam = null; mapState.focus = el.dataset.focus || null; }
  else if (a === 'map-add-floor') { const f = { id: uid(), name: `Floor ${m.floors.length + 1}` }; mapState.floor = f.id; saveMap({ floors: [...m.floors, f] }); const inp = $('[data-map="floor-name"]'); if (inp) { inp.focus(); inp.select(); } }
  else if (a === 'map-del-floor') { if (m.floors.length > 1 && confirm(`Delete ${floorName(mapState.floor)}?`)) { const bg = { ...m.bg }; delete bg[mapState.floor]; const floors = m.floors.filter(f => f.id !== mapState.floor); const doors = m.doors.filter(d => d.floor !== mapState.floor); mapState.floor = floors[0].id; await saveMap({ floors, bg, doors }); } }
  else if (a === 'map-del-room') { if (confirm('Delete this piece of the layout? Components stay where they are.')) { const id = mapState.selected; mapState.selected = null; await saveMap({ rooms: m.rooms.filter(r => r.id !== id) }); } }
  else if (a === 'map-room-kind') { const cur = m.rooms.find(r => r.id === mapState.selected); if (cur) await saveMap({ rooms: m.rooms.map(r => { if (!(r.floor === cur.floor && roomKey(r) === roomKey(cur))) return r; const { kind, ...rest } = r; return el.dataset.value ? { ...rest, kind: el.dataset.value } : rest; }) }); }
  else if (a === 'map-room-color') { const cur = m.rooms.find(r => r.id === mapState.selected); if (cur) await saveMap({ rooms: m.rooms.map(r => r.floor === cur.floor && roomKey(r) === roomKey(cur) ? { ...r, color: Number(el.dataset.value) } : r) }); }
  else if (a === 'map-load-house') { await loadHouseLayout(); }
  else if (a === 'map-place') { mapState.placing = el.dataset.id; mapState.mode = 'edit'; if (state.route.view !== 'map') location.hash = '#/map'; else render(); }
  else if (a === 'map-place-cancel') { mapState.placing = null; render(); }
  else if (a === 'map-unplace') { const as = store.assets[el.dataset.id]; if (as) { const copy = { ...as }; delete copy.map; store.assets[as.id] = copy; await save('assets', { ...copy, map: null }); } }
  else if (a === 'map-bg-remove') { const bg = { ...m.bg }; delete bg[mapState.floor]; await saveMap({ bg }); }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.action === 'map-bg' && t.files[0]) { mapBackground(t.files[0]).catch(() => toast("Couldn't read that image.", true)); return; }
  if (t.dataset.map === 'floor-name') { const v = t.value.trim(); if (v) await saveMap({ floors: mapData().floors.map(f => f.id === mapState.floor ? { ...f, name: v } : f) }); }
  if (t.dataset.map === 'room-name') { const v = t.value.trim(); if (v) { const m = mapData(); const cur = m.rooms.find(r => r.id === mapState.selected); const twin = cur && m.rooms.find(r => r.id !== cur.id && r.floor === cur.floor && roomKey(r) === v.toLowerCase()); const oldKey = cur && roomKey(cur); await saveMap({ rooms: m.rooms.map(r => r.id === mapState.selected ? { ...r, name: v, color: twin ? (twin.color ?? 0) : r.color } : r) });
    // the last piece with the old name takes its room-assigned components along
    if (cur && !mapData().rooms.some(r => r.floor === cur.floor && roomKey(r) === oldKey)) for (const a of list('assets')) if (a.map && a.map.room === oldKey && a.map.floor === cur.floor) await save('assets', { ...a, map: { floor: cur.floor, room: v.toLowerCase() } }); } }
  if (t.dataset.map === 'place-room') { const a = store.assets[t.dataset.id]; const v = t.value; if (a && v) { const [floor, ...rest] = v.split('|'); await save('assets', { ...a, map: { floor, room: rest.join('|') } }); toast(`${a.name} placed`); } }
});
document.addEventListener('keydown', e => {
  if (state.route.view === 'map' && mapState.mode === 'edit' && (e.key === 'Delete' || e.key === 'Backspace') && mapState.selected && !/input|textarea/i.test(e.target.tagName)) {
    e.preventDefault(); const id = mapState.selected; mapState.selected = null; saveMap({ rooms: mapData().rooms.filter(r => r.id !== id) });
  }
  if (e.key === 'Escape' && (mapState.placing || mapState.tool)) { mapState.placing = null; mapState.tool = null; render(); }
});

// ---------------------------------------------------------------- editor dialog
function openEditor(coll, data = {}, presets = {}) {
  const s = SCHEMA[coll];
  const isNew = !data.id;
  $('#editor-title').textContent = `${isNew ? 'New' : 'Edit'} ${s.one.toLowerCase()}`;
  const fields = $('#editor-fields');
  fields.innerHTML = s.fields.map(f => {
    const v = data[f.k] ?? presets[f.k] ?? (isNew && f.def ? f.def() : '');
    const id = `f-${f.k}`;
    let input;
    if (f.t === 'select') input = `<select id="${id}" name="${f.k}">${f.opts.map(o => `<option value="${esc(o)}" ${String(v) === String(o) ? 'selected' : ''}>${esc(o) || '—'}</option>`).join('')}</select>`;
    else if (f.t === 'asset') { const opts = list('assets').filter(a => !(data.id && isInside(a, data.id))).sort(by('name')); input = `<select id="${id}" name="${f.k}"><option value="">— none —</option>${opts.map(a => `<option value="${a.id}" ${v === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`; }
    else if (f.t === 'room') { const cur = roomValue(data); input = `<select id="${id}" name="${f.k}" data-initial="${esc(cur)}">${roomOptions(cur)}</select>`; }
    else if (f.t === 'md') input = `<textarea id="${id}" name="${f.k}" spellcheck="true">${esc(v)}</textarea>`;
    else input = `<input id="${id}" name="${f.k}" type="${f.t === 'md' ? 'text' : f.t}" value="${esc(v)}" ${f.req ? 'required' : ''} ${f.ph ? `placeholder="${esc(f.ph)}"` : ''} ${f.t === 'number' ? 'step="any" inputmode="decimal"' : ''}>`;
    return `<div class="field ${f.wide ? 'wide' : ''}"><label for="${id}">${esc(f.l)}</label>${input}</div>`;
  }).join('');
  const dlg = $('#editor');
  dlg.dataset.coll = coll; dlg.dataset.id = data.id || '';
  dlg._base = data;
  $('#editor-delete').hidden = isNew;
  dlg.showModal();
  const first = fields.querySelector('input, select, textarea'); if (first) first.focus();
}

$('#editor-form').addEventListener('submit', async e => {
  e.preventDefault();
  const dlg = $('#editor'); const coll = dlg.dataset.coll; const s = SCHEMA[coll];
  const out = { ...(dlg._base || {}) };
  for (const f of s.fields) {
    const el = $(`#f-${f.k}`); let v = el.value;
    if (f.t === 'room') { if (v !== el.dataset.initial) { const [floor, ...rest] = v.split('|'); out.map = v ? { floor, room: rest.join('|') } : null; } continue; }
    if (f.t === 'number') v = v === '' ? null : Number(v);
    if (f.req && (v === '' || v == null)) { el.focus(); return; }
    out[f.k] = v === '' ? null : v;
  }
  if (coll === 'pages') { const wanted = dlg._base.slug || slugify(out.title); out.slug = wanted; const clash = list('pages').find(p => p.slug === wanted && p.id !== out.id); if (clash) out.slug = `${wanted}-${uid().slice(0, 4)}`; }
  dlg.close();
  const saved = await save(coll, out);
  toast(`${s.one} saved`);
  if (!dlg._base.id && ['assets', 'projects', 'pages'].includes(coll)) location.hash = coll === 'pages' ? `#/pages/${saved.slug}` : `#/${coll}/${saved.id}`;
});
$('#editor-delete').addEventListener('click', async () => {
  const dlg = $('#editor'); const coll = dlg.dataset.coll; const id = dlg.dataset.id;
  if (!confirm(`Delete this ${SCHEMA[coll].one.toLowerCase()}? This can't be undone.`)) return;
  dlg.close(); await remove(coll, id);
  if (state.route.view === coll && state.route.id) location.hash = `#/${coll}`;
});
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

function openPicker() {
  $('#picker-grid').innerHTML = COLLS.map(c => `<button type="button" data-action="new" data-coll="${c}"><b>${SCHEMA[c].one}</b><span>${SCHEMA[c].blurb}</span></button>`).join('');
  $('#picker').showModal();
}

// ---------------------------------------------------------------- actions
async function completeSchedule(id) {
  const s = store.schedule[id]; if (!s) return;
  const t = today();
  await save('log', { item: s.task, date: t, area: s.area || null, asset: s.asset || null, doneBy: 'Me', notes: null });
  const next = { ...s, lastDone: t };
  if (s.unit !== 'miles' && s.every) next.nextDue = addInterval(t, Number(s.every), s.unit || 'months');
  await save('schedule', next);
  toast(`Logged “${s.task}”${next.nextDue && s.unit !== 'miles' ? `, next due ${fmtDate(next.nextDue)}` : ''}`);
}
async function toggleTodo(id) {
  const t = store.todos[id]; if (!t) return;
  await save('todos', { ...t, status: t.status === 'done' ? 'open' : 'done', doneOn: t.status === 'done' ? null : today() });
}
function exportJSON() {
  const data = Object.fromEntries(COLLS.map(c => [c, list(c)]));
  const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), ...data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `home-base-${today()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importJSON(file) {
  try {
    const data = JSON.parse(await file.text());
    let n = 0; const batch = writeBatch(db);
    for (const c of COLLS) for (const d of (data[c] || [])) { if (!d.id) continue; batch.set(userDoc(c, d.id), d, { merge: true }); n++; }
    await batch.commit(); toast(`Imported ${n} records`);
  } catch (e) { toast(`Import failed (${e.message})`, true); }
}

async function seed() {
  const have = (c, k, v) => list(c).some(d => String(d[k] || '').toLowerCase() === v.toLowerCase());
  const batch = writeBatch(db); let n = 0;
  const put = (c, d) => { const id = uid(); const now = Date.now(); const doc_ = { ...d, id, created: now, updated: now }; if (c === 'pages') doc_.slug = slugify(d.title); batch.set(userDoc(c, id), doc_); n++; };
  const sched = [
    ['Replace furnace filter', 'House', 3, 'months', '2027-02-01', 'Record the filter size on the furnace asset so it is one tap away at the store.'],
    ['Test smoke and CO detectors, replace batteries', 'House', 6, 'months', '2027-03-14', 'Pair with the clock changes in March and November.'],
    ['Clean gutters and downspouts', 'House', 6, 'months', '2027-04-15', 'Spring after the pollen, fall after the leaves.'],
    ['Flush water heater', 'House', 12, 'months', '2027-06-01', 'Check the anode rod every few years.'],
    ['Service furnace or heat pump', 'House', 12, 'months', '2027-09-15', 'Book before the first cold snap.'],
    ['Drain hoses and winterize outdoor faucets', 'Yard', 12, 'months', '2026-11-28', 'Due now if not already done this year.'],
    ['Oil change', 'Car', 5000, 'miles', null, 'Add the car as an asset with its oil spec and last service mileage.'],
    ['Rotate tires', 'Car', 10000, 'miles', null, 'Usually every other oil change.'],
    ['Replace engine and cabin air filters', 'Car', 12, 'months', null, 'Record both part numbers on the car asset.']
  ];
  for (const [task, area, every, unit, nextDue, notes] of sched) if (!have('schedule', 'task', task)) put('schedule', { task, area, every, unit, nextDue, notes, asset: null, lastDone: null, season: null });
  const projects = [
    { name: 'Trailhead Almanac', status: 'live', started: '2026-11-21', liveUrl: 'https://dhumphre.github.io/WeatherTrack/', repo: 'https://github.com/dhumphre/WeatherTrack', services: 'GitHub Pages, Firebase, Claude Code, Open-Meteo, NWS', tags: 'web, hiking', summary: 'Hikeable-weather ledger for nearby places, one to three days out.', body: '## What it does\n\n- Pulls National Weather Service forecasts (no key) for each saved place and scores the next three days for hikeability.\n- Air quality from Open-Meteo shows per day and per hour; NWS Air Quality Alerts show as a badge.\n- Google sign-in syncs the place list across devices through Firebase.\n\n## How it is built\n\n- Single file, `index.html`, no build step. Hosted on GitHub Pages from the main branch.\n- Firebase project **trailhead-almanac**: Google sign-in, Firestore document `users/{uid}` with the places array, owner-only rules.\n- The web API key in the page is public by design. GitHub\'s secret scanner flags it as a false positive.\n\n## Updating\n\n```\ngit add index.html; git commit -m "Describe the change"; git push\n```\n\nScore weights live in `summarizeDay` in index.html.' },
    { name: 'Home Base', status: 'live', started: '2026-11-21', liveUrl: 'https://dhumphre.github.io/HomeBase/', repo: 'https://github.com/dhumphre/HomeBase', services: 'GitHub Pages, Firebase, Claude Code', tags: 'web, home', summary: 'This site: the logbook for the house, the cars and the projects.', body: '## How it is built\n\n- Three files: `index.html`, `styles.css`, `app.js`. No build step. Hosted on GitHub Pages.\n- Shares the **trailhead-almanac** Firebase project. Data lives in Firestore under `users/{uid}/{collection}/{id}` for assets, log, schedule, todos, projects and pages, with owner-only rules.\n- Markdown rendered with marked and sanitized with DOMPurify. `[[Page title]]` links between wiki pages.\n\n## Updating\n\n```\ngit add .; git commit -m "Describe the change"; git push\n```' },
    { name: 'Goat Rocks Field Notes', status: 'live', liveUrl: 'https://goat-rocks-field-notes.thetrunkmonkey.chatgpt.site/', services: 'ChatGPT', tags: 'web, hiking', summary: 'Trip log and shared photo roll for a three-day Goat Rocks Wilderness backpack.', body: '- Berry Patch to Walupt Lake via Goat Lake, Snowgrass Flats, Old Snowy, Cispus Pass and Nannie Peak. Five backpackers, three days, about 22.6 miles and 5,400 ft of climbing.\n- Route map with per-day legs, camera and phone galleries, and a shared roll trip members add to with a private trip code.' },
    { name: 'Removertise', status: 'live', liveUrl: 'https://removertise-control.dhumphre.workers.dev/', services: 'Cloudflare Workers, Cloudflare Access', tags: 'web', summary: 'Removertise remote control panel on Cloudflare Workers, behind a Cloudflare Access login.', body: '- Served from a Cloudflare Worker on dhumphre.workers.dev, with Cloudflare Access (team yellow-glade-0073) in front.\n- Add what it does, where the code lives, and how it deploys.' }
  ];
  for (const p of projects) if (!have('projects', 'name', p.name)) put('projects', p);
  if (!have('pages', 'title', 'Start here')) put('pages', { title: 'Start here', area: '', body: '# Start here\n\nThis is your logbook. A few habits make it earn its keep:\n\n- **Log work the day it happens.** From Home, hit *Log work*. Link it to the asset so the asset page builds its own history.\n- **Put part numbers on assets.** Filter sizes, oil spec, tire size, the plumber\'s number. Open the asset at the store.\n- **Let Schedule do the remembering.** When something is due, press *Done* and it logs the work and rolls the date forward.\n- **Write pages for the rest.** Where the water shutoff is, how the sprinkler controller works, what the mechanic said. Link pages with double brackets, like [[House overview]].\n\nAsk Claude to log, look up or summarize any of this.' });
  if (!have('pages', 'title', 'House overview')) put('pages', { title: 'House overview', area: 'House', body: '# House overview\n\n## Shutoffs\n\n- Water main: \n- Gas: \n- Electrical panel: \n\n## People to call\n\n| Who | For | Number |\n| --- | --- | --- |\n|  |  |  |\n\n## Quirks\n\n- ' });
  if (!n) { toast('Starter content is already here'); return; }
  try { await batch.commit(); toast(`Added ${n} starter items`); } catch (e) { toast(`Couldn't add starter content (${e.code || e.message})`, true); }
}

// The two cars, each with a Subaru-style service schedule linked to it. Parked in the garage if the map has one.
async function seedCars() {
  const cars = [
    { name: '2020 Subaru Legacy', year: 2020, make: 'Subaru Legacy', type: 'Sedan', specs: 'Oil: 0W-20 synthetic. Tires: 225/65R17 (check the door jamb). Add VIN, plate and last service mileage.' },
    { name: '2017 Subaru Crosstrek', year: 2017, make: 'Subaru Crosstrek', type: 'Crossover', specs: 'Oil: 0W-20 synthetic. Tires: 225/55R17 (check the door jamb). Add VIN, plate and last service mileage.' }];
  const service = [['Oil and filter change', 6, 'months'], ['Rotate tires', 6, 'months'], ['Replace engine and cabin air filters', 12, 'months'], ['Replace wiper blades', 12, 'months'], ['Brake fluid exchange', 36, 'months'], ['Registration renewal', 12, 'months']];
  const existing = list('assets'); const garage = mapData().rooms.find(r => roomKey(r) === 'garage');
  const batch = writeBatch(db); let n = 0; const now = Date.now();
  cars.forEach((c, i) => {
    if (existing.some(a => a.name.toLowerCase() === c.name.toLowerCase())) return;
    const id = uid(); const map = garage ? { floor: garage.floor, x: garage.x + Math.round(garage.w * (i ? 0.7 : 0.3) / SNAP) * SNAP, y: garage.y + Math.round(garage.h * 0.55 / SNAP) * SNAP } : null;
    batch.set(userDoc('assets', id), { ...c, id, area: 'Car', serial: null, purchased: null, contact: null, manual: null, notes: '', map, created: now, updated: now }); n++;
    for (const [task, every, unit] of service) { const sid = uid(); batch.set(userDoc('schedule', sid), { id: sid, task, area: 'Car', asset: id, every, unit, nextDue: null, lastDone: null, season: null, notes: 'Press Done after the next service and the date rolls forward.', created: now, updated: now }); n++; }
  });
  if (!n) { toast('Both cars are already here'); return; }
  try { await batch.commit(); toast(`Added both cars and ${n - 2} service items`); } catch (e) { toast(`Couldn't add the cars (${e.code || e.message})`, true); }
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action;
  if (a === 'new') {
    $('#picker').open && $('#picker').close();
    const presets = {}; if (el.dataset.asset) presets.asset = el.dataset.asset; if (el.dataset.area) presets.area = el.dataset.area; if (el.dataset.title) presets.title = el.dataset.title;
    const base = el.dataset.slug ? { slug: el.dataset.slug } : {};
    openEditor(el.dataset.coll, base, presets);
  }
  else if (a === 'edit') openEditor(el.dataset.coll, store[el.dataset.coll][el.dataset.id]);
  else if (a === 'complete') completeSchedule(el.dataset.id);
  else if (a === 'toggle-todo') toggleTodo(el.dataset.id);
  else if (a === 'edit-page') { state.editing.page = el.dataset.id; render(); $('#page-editor').focus(); }
  else if (a === 'cancel-page') { state.editing.page = null; render(); }
  else if (a === 'save-page') { const p = store.pages[el.dataset.id]; state.editing.page = null; await save('pages', { ...p, body: $('#page-editor').value }); toast('Page saved'); }
  else if (a === 'seed') seed();
  else if (a === 'seed-cars') seedCars();
  else if (a === 'export') exportJSON();
  else if (a === 'theme') { const v = el.dataset.value; try { if (v === 'system') { delete document.documentElement.dataset.theme; localStorage.removeItem('hb.theme'); } else { document.documentElement.dataset.theme = v; localStorage.setItem('hb.theme', v); } } catch {} render(); }
});
document.addEventListener('click', e => {
  const b = e.target.closest('button[data-filter]'); if (!b) return;
  (state.filters[b.dataset.filter] ||= {})[b.dataset.key] = b.dataset.value; render();
});
document.addEventListener('input', e => {
  const i = e.target.closest('input[data-filter]'); if (!i) return;
  (state.filters[i.dataset.filter] ||= {})[i.dataset.key] = i.value;
  const pos = i.selectionStart; render();
  const again = $(`input[data-filter="${i.dataset.filter}"]`); if (again) { again.focus(); again.setSelectionRange(pos, pos); }
});
document.addEventListener('change', e => { if (e.target.dataset.action === 'import' && e.target.files[0]) importJSON(e.target.files[0]); });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id === 'page-editor') { e.preventDefault(); $('[data-action="save-page"]').click(); }
  if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && state.user && !/input|textarea|select/i.test(e.target.tagName) && !$('#editor').open) { e.preventDefault(); openPicker(); }
});
// wiki links to pages that don't exist yet open the editor prefilled
document.addEventListener('click', e => {
  const a = e.target.closest('a.wiki.missing'); if (!a) return;
  e.preventDefault(); openEditor('pages', { slug: slugify(a.dataset.title) }, { title: a.dataset.title });
});

$('#landing-signin').addEventListener('click', signIn);
$('#signout').addEventListener('click', () => signOut(auth));
$('#new-btn').addEventListener('click', openPicker);
try { const t = localStorage.getItem('hb.theme'); if (t) document.documentElement.dataset.theme = t; } catch {}

window.HB = { state, store, render, save, SCHEMA }; // handy in the console
render();
