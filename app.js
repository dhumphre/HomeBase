// Home Base: a private logbook for the house, the cars and the projects.
// Single-page app. Data lives in Firestore under users/{uid}/{collection}/{id}, synced live.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { initializeFirestore, getFirestore, persistentLocalCache, collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

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
const state = { user: null, ready: false, route: { view: 'home', id: null }, filters: {}, editing: {} };
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

function userDoc(coll, id) { return doc(db, 'users', state.user.uid, coll, id); }

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
  unsubs.push(onSnapshot(doc(db, 'users', state.user.uid, 'map', 'layout'), snap => { store.map = snap.exists() ? snap.data() : null; render(); }, () => {}));
  let pending = COLLS.length;
  for (const c of COLLS) {
    const u = onSnapshot(collection(db, 'users', state.user.uid, c), snap => {
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

onAuthStateChanged(auth, user => {
  state.user = user; state.ready = false;
  for (const c of COLLS) store[c] = {};
  store.map = null;
  if (user) { $('#who').textContent = user.displayName || user.email || ''; subscribeAll(); }
  else unsubscribeAll();
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
  $('#main').innerHTML = fn(id);
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
    : `<div class="card"><div class="empty">No assets yet. Start with the furnace, the water heater and each car. Put the filter size or oil spec in Specs and it's one tap away at the store.</div></div>`}`;
}

function assetDetail(id) {
  const a = store.assets[id];
  if (!a) return head('Not found', { crumbs: `<a href="#/assets">Assets</a>` });
  const history = list('log').filter(l => l.asset === id).sort(by('date', -1));
  const sched = list('schedule').filter(s => s.asset === id).sort((x, y) => (x.nextDue || '9999') > (y.nextDue || '9999') ? 1 : -1);
  const open = list('todos').filter(t => t.asset === id && t.status !== 'done');
  const spent = history.reduce((s, l) => s + (Number(l.cost) || 0), 0);
  const room = a.map ? roomAt(a.map) : null;
  const props = [['Area', chip(a.area)], ['Type', esc(a.type)], ['Make / model', esc(a.make)], ['Serial / VIN', a.serial ? `<code>${esc(a.serial)}</code>` : ''], ['Year', esc(a.year)], ['Purchased', fmtDate(a.purchased)], ['Specs', esc(a.specs)], ['Contact', esc(a.contact)], ['Manual', a.manual ? `<a href="${esc(a.manual)}" target="_blank" rel="noopener">open ↗</a>` : ''], ['On map', a.map ? `<a href="#/map" data-action="map-goto" data-floor="${esc(a.map.floor)}">${esc(room ? room.name : floorName(a.map.floor))}</a>` : btn('Place on map', 'map-place', `data-id="${id}"`, 'btn small')], ['Spent', spent ? money(spent) : '']].filter(([, v]) => v);
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
      <section class="card"><header><h2>Starter content</h2></header><div style="padding:14px 16px;display:grid;gap:10px"><p style="margin:0;color:var(--ink-2);font-size:14px">Adds a typical house schedule, a how-to page and your current projects. Skips anything with the same name that already exists.</p><div>${btn('Add starter content', 'seed')}</div></div></section>
      <section class="card"><header><h2>Account</h2></header><div style="padding:14px 16px;font-size:14px;color:var(--ink-2)">Signed in as ${esc(state.user.email || state.user.displayName || '')}. Data is stored in Firebase under your user id and readable only by you.</div></section>
    </div>`;
}

// ---------------------------------------------------------------- map
// Rooms live in one document (map/layout); each asset carries its own map position {floor, x, y}.
const MAP_W = 1000, MAP_H = 640, SNAP = 10;
const mapState = { floor: null, mode: 'view', selected: null, placing: null, drag: null, pendingRender: false, hover: null };
function mapData() {
  const m = store.map || {};
  return { floors: m.floors && m.floors.length ? m.floors : [{ id: 'main', name: 'Main floor' }], rooms: m.rooms || [], bg: m.bg || {} };
}
function floorName(id) { const f = mapData().floors.find(f => f.id === id); return f ? f.name : ''; }
function roomAt(pos) { return mapData().rooms.find(r => r.floor === pos.floor && pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h) || null; }
async function saveMap(patch) {
  const m = { ...mapData(), ...patch, id: 'layout', updated: Date.now() };
  store.map = m; render();
  try { await setDoc(doc(db, 'users', state.user.uid, 'map', 'layout'), m); }
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
const ICONS = [[/furnace|heat pump|boiler|hvac/i, '🔥'], [/water heater/i, '🚿'], [/car|truck|suv|wagon|sedan|subaru|toyota|honda|ford|jeep|tesla/i, '🚗'], [/mower|tractor/i, '🚜'], [/fridge|refrigerator|freezer/i, '🧊'], [/washer|dryer|laundry/i, '🧺'], [/dishwasher/i, '🍽️'], [/range|oven|stove|cooktop/i, '🍳'], [/air cond|\bac\b|mini.?split/i, '❄️'], [/sprinkler|irrigation|hose/i, '💦'], [/roof|chimney/i, '🏠'], [/gutter/i, '🌧️'], [/panel|electric|breaker/i, '⚡'], [/garage door/i, '🚪'], [/sump|pump|well|septic/i, '💧'], [/generator|battery|solar/i, '🔋'], [/tree|garden|lawn/i, '🌳'], [/bike|bicycle/i, '🚲'], [/smoke|detector|alarm/i, '🚨'], [/window|skylight/i, '🪟'], [/deck|fence|shed/i, '🪵'], [/router|wifi|network|modem/i, '📡'], [/thermostat/i, '🌡️'], [/fireplace|wood stove/i, '🪵'], [/hot tub|spa|pool/i, '🛁'], [/grill|bbq|smoker/i, '🍖']];
function assetIcon(a) { const t = `${a.name} ${a.type || ''} ${a.make || ''}`; for (const [re, ic] of ICONS) if (re.test(t)) return ic; return a.area === 'Car' ? '🚗' : a.area === 'Yard' ? '🌿' : '🔧'; }

function map() {
  const m = mapData();
  if (!mapState.floor || !m.floors.some(f => f.id === mapState.floor)) mapState.floor = m.floors[0].id;
  const floor = m.floors.find(f => f.id === mapState.floor);
  const rooms = m.rooms.filter(r => r.floor === floor.id);
  const placed = list('assets').filter(a => a.map && a.map.floor === floor.id);
  const unplaced = list('assets').filter(a => !a.map).sort(by('name'));
  const edit = mapState.mode === 'edit';
  const sel = edit && mapState.selected ? m.rooms.find(r => r.id === mapState.selected) : null;
  const placingAsset = mapState.placing ? store.assets[mapState.placing] : null;

  const roomsSvg = rooms.map((r, i) => `<g class="room t${r.color ?? i % 6} ${sel && sel.id === r.id ? 'sel' : ''}" data-room="${r.id}">
      <rect class="floor" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="8"/>
      <rect class="sheen" x="${r.x + 3}" y="${r.y + 3}" width="${Math.max(0, r.w - 6)}" height="${Math.max(0, r.h - 6)}" rx="6"/>
      <rect class="wall" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="8"/>
      <text class="room-label" x="${r.x + 12}" y="${r.y + 22}">${esc(r.name)}</text>
      ${edit ? `<rect class="handle" data-handle="${r.id}" x="${r.x + r.w - 14}" y="${r.y + r.h - 14}" width="14" height="14" rx="3"/>` : ''}
    </g>`).join('');
  const markersSvg = placed.map(a => { const st = assetStatus(a.id); return `<g class="marker ${st.cls}" data-asset="${a.id}" transform="translate(${a.map.x},${a.map.y})">
      <circle class="halo" r="26"/><circle class="disc" r="18"/>
      <text class="glyph" y="6" text-anchor="middle">${assetIcon(a)}</text>
      <text class="mlabel" y="36" text-anchor="middle">${esc(a.name)}</text>
    </g>`; }).join('');
  const bg = m.bg[floor.id] ? `<image href="${m.bg[floor.id]}" x="0" y="0" width="${MAP_W}" height="${MAP_H}" preserveAspectRatio="xMidYMid meet" class="bgimg"/>` : '';

  const floorTabs = `<div class="seg">${m.floors.map(f => `<button type="button" aria-pressed="${f.id === floor.id}" data-action="map-floor" data-id="${f.id}">${esc(f.name)}</button>`).join('')}</div>`;
  const statusRows = placed.map(a => ({ a, st: assetStatus(a.id) })).sort((x, y) => ['over', 'soon', 'todo', 'ok', 'none'].indexOf(x.st.cls) - ['over', 'soon', 'todo', 'ok', 'none'].indexOf(y.st.cls));

  const panel = edit ? `
      <section class="card"><header><h2>Editing ${esc(floor.name)}</h2></header>
        <div class="map-panel">
          <p class="hint">Drag on empty space to draw a room. Drag a room to move it, its corner to resize. Drag components to move them.</p>
          <label class="field"><span>Floor name</span><input type="text" value="${esc(floor.name)}" data-map="floor-name"></label>
          <div class="row">${btn('+ Floor', 'map-add-floor')}${m.floors.length > 1 && !rooms.length && !placed.length ? btn('Delete floor', 'map-del-floor', '', 'btn small danger') : ''}</div>
          <label class="field"><span>Floor plan image (optional)</span><span class="row">${m.bg[floor.id] ? btn('Remove image', 'map-bg-remove', '', 'btn small') : ''}<label class="btn small">Upload<input type="file" accept="image/*" data-action="map-bg" hidden></label></span></label>
        </div>
      </section>
      ${sel ? `<section class="card"><header><h2>Room</h2></header><div class="map-panel">
          <label class="field"><span>Name</span><input type="text" id="room-name" value="${esc(sel.name)}" data-map="room-name"></label>
          <div class="swatches">${[0, 1, 2, 3, 4, 5].map(i => `<button type="button" class="swatch t${i} ${(sel.color ?? 0) === i ? 'on' : ''}" data-action="map-room-color" data-value="${i}" aria-label="Color ${i + 1}"></button>`).join('')}</div>
          <div class="row">${btn('Delete room', 'map-del-room', '', 'btn small danger')}</div></div></section>` : ''}
      <section class="card"><header><h2>Place components</h2><span class="more">${unplaced.length}</span></header>
        ${placingAsset ? `<div class="callout small"><p>Click on the map to place <b>${esc(placingAsset.name)}</b>.</p>${btn('Cancel', 'map-place-cancel')}</div>` : ''}
        ${unplaced.length ? `<ul class="rows">${unplaced.map(a => `<li><span class="t">${assetIcon(a)} ${esc(a.name)}<span class="sub">${esc(a.area || '')}</span></span>${btn('Place', 'map-place', `data-id="${a.id}"`)}</li>`).join('')}</ul>` : `<div class="empty">Every asset is on the map. Add more under Assets.</div>`}
      </section>
      ${placed.length ? `<section class="card"><header><h2>On this floor</h2></header><ul class="rows">${placed.sort(by('name')).map(a => `<li><span class="t">${assetIcon(a)} ${esc(a.name)}</span>${btn('Unplace', 'map-unplace', `data-id="${a.id}"`, 'btn small ghost')}</li>`).join('')}</ul></section>` : ''}`
    : `
      <section class="card"><header><h2>Status</h2></header>
        <ul class="legend"><li><i class="over"></i>Overdue</li><li><i class="soon"></i>Due within 30 days</li><li><i class="todo"></i>Open to-do</li><li><i class="ok"></i>All good</li><li><i class="none"></i>Nothing scheduled</li></ul>
      </section>
      <section class="card"><header><h2>On ${esc(floor.name)}</h2><span class="more">${placed.length}</span></header>
        ${statusRows.length ? `<ul class="rows">${statusRows.map(({ a, st }) => `<li data-hl="${a.id}"><a class="t" href="#/assets/${a.id}">${assetIcon(a)} ${esc(a.name)}<span class="sub">${esc(st.label)}</span></a><i class="dot ${st.cls}"></i></li>`).join('')}</ul>` : `<div class="empty">Nothing placed on this floor yet. Switch to Edit to draw rooms and place components.</div>`}
      </section>`;

  return `
    ${head('Map', { eyebrow: `${m.rooms.length} rooms · ${list('assets').filter(a => a.map).length} of ${list('assets').length} components placed`, actions: floorTabs + (edit ? btn('Done editing', 'map-mode', 'data-value="view"', 'btn primary small') : btn('Edit layout', 'map-mode', 'data-value="edit"', 'btn small')) })}
    ${!rooms.length && !edit ? `<div class="callout"><p><b>No rooms on ${esc(floor.name)} yet.</b> Draw a few rooms, or upload a floor plan image as the background, then place components. Rough is fine; this is a stage, not a survey.</p>${btn('Edit layout', 'map-mode', 'data-value="edit"', 'btn primary small')}</div>` : ''}
    <div class="map-layout">
      <div class="map-wrap ${edit ? 'edit' : ''} ${placingAsset ? 'placing' : ''}">
        <svg id="map-svg" viewBox="0 0 ${MAP_W} ${MAP_H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="House map">
          <defs><pattern id="grid" width="${SNAP * 5}" height="${SNAP * 5}" patternUnits="userSpaceOnUse"><path d="M ${SNAP * 5} 0 L 0 0 0 ${SNAP * 5}" class="gridline"/></pattern></defs>
          <rect width="${MAP_W}" height="${MAP_H}" class="ground"/>${bg}<rect width="${MAP_W}" height="${MAP_H}" fill="url(#grid)" class="gridfill"/>
          <g id="rooms">${roomsSvg}</g><g id="markers">${markersSvg}</g><g id="scratch"></g>
        </svg>
        <div class="map-tip" id="map-tip" hidden></div>
      </div>
      <aside class="map-side">${panel}</aside>
    </div>`;
}

function tipHtml(id) {
  const a = store.assets[id]; if (!a) return '';
  const st = assetStatus(id);
  const next = st.items.slice(0, 3).map(s => { const [lbl, cls] = dueLabel(s.nextDue); return `<li><span>${esc(s.task)}</span><span class="${cls.replace('m ', '')}">${lbl}</span></li>`; }).join('');
  return `<div class="tip-head"><span class="glyph">${assetIcon(a)}</span><div><b>${esc(a.name)}</b><div class="sub">${esc([a.type, a.make].filter(Boolean).join(' · '))}</div></div><i class="dot ${st.cls}"></i></div>
    <div class="tip-status ${st.cls}">${esc(st.label)}</div>
    ${next ? `<ul class="tip-list">${next}</ul>` : ''}
    ${st.todos.length ? `<div class="tip-line">${st.todos.length} open to-do${st.todos.length > 1 ? 's' : ''}: ${esc(st.todos.slice(0, 2).map(t => t.name).join(', '))}</div>` : ''}
    ${st.last ? `<div class="tip-line">Last: ${esc(st.last.item)} · ${fmtDate(st.last.date)}</div>` : '<div class="tip-line">No work logged yet</div>'}
    ${a.specs ? `<div class="tip-line mono">${esc(a.specs)}</div>` : ''}
    <div class="tip-foot">Click to open</div>`;
}

function bindMap() {
  const svg = $('#map-svg'); if (!svg) return;
  const wrap = svg.parentElement; const tip = $('#map-tip');
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
      else if (d.type === 'resize') { const w = Math.max(40, d.orig.w + dx), h = Math.max(40, d.orig.h + dy); d.el.querySelectorAll('rect.floor, rect.wall').forEach(r => { r.setAttribute('width', w); r.setAttribute('height', h); }); const sh = d.el.querySelector('rect.sheen'); sh.setAttribute('width', Math.max(0, w - 6)); sh.setAttribute('height', Math.max(0, h - 6)); const hd = d.el.querySelector('.handle'); hd.setAttribute('x', d.orig.x + w - 14); hd.setAttribute('y', d.orig.y + h - 14); }
      else if (d.type === 'draw') { const x = Math.min(d.start.x, p.x), y = Math.min(d.start.y, p.y); d.rect.setAttribute('x', snap(x)); d.rect.setAttribute('y', snap(y)); d.rect.setAttribute('width', Math.abs(snap(p.x) - snap(d.start.x))); d.rect.setAttribute('height', Math.abs(snap(p.y) - snap(d.start.y))); }
      return;
    }
    const g = e.target.closest('[data-asset]');
    showTip(g ? g.dataset.asset : null, e);
  });
  svg.addEventListener('pointerleave', () => { if (!mapState.drag) tip.hidden = true; });

  svg.addEventListener('pointerdown', e => {
    if (mapState.mode !== 'edit' || e.button !== 0) return;
    const p = pt(e);
    if (mapState.placing) {
      const a = store.assets[mapState.placing]; mapState.placing = null;
      if (a) save('assets', { ...a, map: { floor: mapState.floor, x: clamp(snap(p.x), MAP_W), y: clamp(snap(p.y), MAP_H) } });
      toast(`${a ? a.name : 'Component'} placed`); return;
    }
    const handle = e.target.closest('[data-handle]'), marker = e.target.closest('[data-asset]'), rm = e.target.closest('[data-room]');
    e.preventDefault(); svg.setPointerCapture(e.pointerId);
    if (handle) mapState.drag = { type: 'resize', id: handle.dataset.handle, start: p, orig: { ...room(handle.dataset.handle) }, el: handle.closest('g') };
    else if (marker) mapState.drag = { type: 'asset', id: marker.dataset.asset, start: p, orig: { ...store.assets[marker.dataset.asset].map }, el: marker };
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
    else if (d.type === 'asset') { const a = store.assets[d.id]; const pos = { floor: mapState.floor, x: clamp(snap(d.orig.x + dx), MAP_W), y: clamp(snap(d.orig.y + dy), MAP_H) }; if (pos.x !== a.map.x || pos.y !== a.map.y) await save('assets', { ...a, map: pos }); else render(); }
    else if (d.type === 'draw') {
      d.rect.remove();
      const x = snap(Math.min(d.start.x, p.x)), y = snap(Math.min(d.start.y, p.y)), w = Math.abs(snap(p.x) - snap(d.start.x)), h = Math.abs(snap(p.y) - snap(d.start.y));
      if (w >= 40 && h >= 40) { const r = { id: uid(), floor: mapState.floor, name: 'New room', x, y, w, h, color: m.rooms.length % 6 }; mapState.selected = r.id; saveMap({ rooms: [...m.rooms, r] }); const inp = $('#room-name'); if (inp) { inp.focus(); inp.select(); } }
      else render();
    }
    if (mapState.pendingRender) { mapState.pendingRender = false; render(); }
  });

  svg.addEventListener('click', e => {
    if (mapState.mode !== 'view') return;
    const g = e.target.closest('[data-asset]'); if (g) location.hash = `#/assets/${g.dataset.asset}`;
  });
  // hovering a row in the side list lights its marker
  wrap.parentElement.addEventListener('pointerover', e => { const li = e.target.closest('[data-hl]'); svg.querySelectorAll('.marker.lit').forEach(m => m.classList.remove('lit')); if (li) { const mk = svg.querySelector(`[data-asset="${li.dataset.hl}"]`); if (mk) mk.classList.add('lit'); } });
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
  if (a === 'map-mode') { mapState.mode = el.dataset.value; mapState.selected = null; mapState.placing = null; render(); }
  else if (a === 'map-floor') { mapState.floor = el.dataset.id; mapState.selected = null; render(); }
  else if (a === 'map-goto') { mapState.floor = el.dataset.floor; mapState.mode = 'view'; }
  else if (a === 'map-add-floor') { const f = { id: uid(), name: `Floor ${m.floors.length + 1}` }; mapState.floor = f.id; saveMap({ floors: [...m.floors, f] }); const inp = $('[data-map="floor-name"]'); if (inp) { inp.focus(); inp.select(); } }
  else if (a === 'map-del-floor') { if (m.floors.length > 1 && confirm(`Delete ${floorName(mapState.floor)}?`)) { const bg = { ...m.bg }; delete bg[mapState.floor]; const floors = m.floors.filter(f => f.id !== mapState.floor); mapState.floor = floors[0].id; await saveMap({ floors, bg }); } }
  else if (a === 'map-del-room') { if (confirm('Delete this room? Components stay where they are.')) { const id = mapState.selected; mapState.selected = null; await saveMap({ rooms: m.rooms.filter(r => r.id !== id) }); } }
  else if (a === 'map-room-color') { await saveMap({ rooms: m.rooms.map(r => r.id === mapState.selected ? { ...r, color: Number(el.dataset.value) } : r) }); }
  else if (a === 'map-place') { mapState.placing = el.dataset.id; mapState.mode = 'edit'; if (state.route.view !== 'map') location.hash = '#/map'; else render(); }
  else if (a === 'map-place-cancel') { mapState.placing = null; render(); }
  else if (a === 'map-unplace') { const as = store.assets[el.dataset.id]; if (as) { const copy = { ...as }; delete copy.map; store.assets[as.id] = copy; await save('assets', { ...copy, map: null }); } }
  else if (a === 'map-bg-remove') { const bg = { ...m.bg }; delete bg[mapState.floor]; await saveMap({ bg }); }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.action === 'map-bg' && t.files[0]) { mapBackground(t.files[0]).catch(() => toast("Couldn't read that image.", true)); return; }
  if (t.dataset.map === 'floor-name') { const v = t.value.trim(); if (v) await saveMap({ floors: mapData().floors.map(f => f.id === mapState.floor ? { ...f, name: v } : f) }); }
  if (t.dataset.map === 'room-name') { const v = t.value.trim(); if (v) await saveMap({ rooms: mapData().rooms.map(r => r.id === mapState.selected ? { ...r, name: v } : r) }); }
});
document.addEventListener('keydown', e => {
  if (state.route.view === 'map' && mapState.mode === 'edit' && (e.key === 'Delete' || e.key === 'Backspace') && mapState.selected && !/input|textarea/i.test(e.target.tagName)) {
    e.preventDefault(); const id = mapState.selected; mapState.selected = null; saveMap({ rooms: mapData().rooms.filter(r => r.id !== id) });
  }
  if (e.key === 'Escape' && mapState.placing) { mapState.placing = null; render(); }
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
    else if (f.t === 'asset') { const opts = list('assets').sort(by('name')); input = `<select id="${id}" name="${f.k}"><option value="">— none —</option>${opts.map(a => `<option value="${a.id}" ${v === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`; }
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
