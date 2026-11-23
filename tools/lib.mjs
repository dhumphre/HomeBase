// Shared data layer for the command-line tool (hb.mjs) and the MCP server (mcp.mjs).
// Talks to Firestore with the Firebase Admin SDK and a service-account key kept OUTSIDE the repo:
//   %USERPROFILE%\.homebase\service-account.json   (or HB_SERVICE_ACCOUNT=<path>)
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export const COLLS = ['assets', 'log', 'schedule', 'todos', 'projects', 'pages'];
export const TITLE = { assets: 'name', log: 'item', schedule: 'task', todos: 'name', projects: 'name', pages: 'title' };
export const keyPath = process.env.HB_SERVICE_ACCOUNT || join(homedir(), '.homebase', 'service-account.json');

export const uid = () => randomUUID().replace(/-/g, '').slice(0, 20);
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => ymd(new Date());
export const addInterval = (s, n, unit) => { const d = new Date(`${s}T12:00:00`); if (unit === 'weeks') d.setDate(d.getDate() + 7 * n); else if (unit === 'years') d.setFullYear(d.getFullYear() + n); else d.setMonth(d.getMonth() + n); return ymd(d); };
export const addDays = (s, n) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
export const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 864e5);
export const daysUntil = s => s ? daysBetween(today(), s) : null;
export const slugify = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'page';
export const fmtMiles = n => Math.round(Number(n)).toLocaleString('en-US');
export const isCar = a => !!a && a.area === 'Car' && !a.parent; // a wheel set installed in a car is a part of it, not a car (the site agrees)
const num = v => v == null || v === '' ? null : Number(v);
// Numbers bound for Firestore: absent ('' or null) becomes null; anything that is not a finite number is refused, so NaN never gets stored.
const finite = (v, what) => { const n = num(v); if (n != null && !Number.isFinite(n)) throw new Error(`${what} must be a number, got "${v}".`); return n; };
const positive = (v, what, of = 'miles') => { const n = num(v); if (n != null && !(Number.isFinite(n) && n > 0)) throw new Error(`${what} must be a number of ${of}, got "${v}".`); return n; };
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const isoDate = s => { if (s && !/^\d{4}-\d{2}-\d{2}$/.test(String(s))) throw new Error(`Date must be YYYY-MM-DD, not "${s}".`); return s || today(); };

let db, UID, ready;
// The data belongs to the household owner: HB_UID, or HB_EMAIL, or the owner named by the access list, or the only user in the project.
export function init() { return ready || (ready = connect()); }
async function connect() {
  if (!existsSync(keyPath)) throw new Error(`No service-account key at ${keyPath}. Firebase console > Project settings > Service accounts > Generate new private key, save it there.`);
  initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
  db = getFirestore();
  if (process.env.HB_UID) UID = process.env.HB_UID;
  else if (process.env.HB_EMAIL) UID = (await getAuth().getUserByEmail(process.env.HB_EMAIL)).uid;
  else {
    const { users } = await getAuth().listUsers(10);
    const owners = (await db.collection('access').get()).docs.map(d => d.data().owner);
    const owner = users.find(u => owners.includes(u.uid)) || (users.length === 1 ? users[0] : null);
    if (!owner) throw new Error(`Several users and no access list; set HB_EMAIL. Users: ${users.map(u => `${u.email} ${u.uid}`).join(', ')}`);
    UID = owner.uid;
  }
  return { db, UID };
}
const coll = c => db.collection('users').doc(UID).collection(c);
const mapRef = () => db.collection('users').doc(UID).collection('map').doc('layout');
export function checkColl(c) { if (!COLLS.includes(c)) throw new Error(`Collection must be one of ${COLLS.join(', ')}`); return c; }

export async function all(c) { await init(); return (await coll(checkColl(c)).get()).docs.map(d => d.data()); }
export async function create(c, data) { await init(); const id = uid(); const now = Date.now(); const doc = { ...clean(data), id, created: now, updated: now }; if (c === 'pages' && !doc.slug) doc.slug = slugify(doc.title); await coll(checkColl(c)).doc(id).set(doc); return doc; }
export async function merge(c, id, data) { await init(); await coll(checkColl(c)).doc(id).set({ ...clean(data), updated: Date.now() }, { merge: true }); }
export async function remove(c, q) { const r = q && typeof q === 'object' ? q : await find(c, q); await coll(checkColl(c)).doc(r.id).delete(); return r; } // q: id/name, or an already-found row

// Rows matching q: the id, else the exact title(s), else case-insensitive substrings of the title.
const matches = (rows, t, q) => { const n = String(q).toLowerCase(); const byId = rows.find(r => r.id === q); if (byId) return [byId]; const exact = rows.filter(r => String(r[t] || '').toLowerCase() === n); return exact.length ? exact : rows.filter(r => String(r[t] || '').toLowerCase().includes(n)); };
const one = (c, q, m) => { if (m.length === 1) return m[0]; if (!m.length) throw new Error(`No ${c.replace(/s$/, '')} matches "${q}".`); throw new Error(`"${q}" matches several ${c}: ${m.map(r => `${r[TITLE[c]]} (${r.id})`).join('; ')}`); };
// One document by id, exact title, or a unique case-insensitive substring of the title.
export async function find(c, q) { return one(c, q, matches(await all(c), TITLE[c], q)); }
export const findAsset = async q => q ? find('assets', q) : null;
// A schedule row. Both cars share task names ("Oil and filter change"), so with assetQ only that asset's tasks are considered; without it a tie lists the owners.
export async function findTask(q, assetQ) {
  const [rows, assets] = await Promise.all([all('schedule'), all('assets')]); const a = assetQ ? one('assets', assetQ, matches(assets, 'name', assetQ)) : null;
  const owner = r => (assets.find(x => x.id === r.asset) || {}).name;
  const m = matches(a ? rows.filter(r => r.asset === a.id) : rows, 'task', q); if (m.length === 1) return m[0];
  if (!m.length) throw new Error(`No task matches "${q}"${a ? ` for ${a.name}` : ''}.`);
  const owners = [...new Set(m.map(owner).filter(Boolean))];
  throw new Error(`"${q}" matches several: ${m.map(r => `${r.task} (${owner(r) || 'no asset'}, id ${r.id})`).join('; ')}.${a || !owners.length ? '' : ` Add asset: ${owners.join(' or ')}`}`);
}

export async function list(c, filters = {}) {
  let rows = await all(c);
  for (const [k, v] of Object.entries(filters)) if (v != null && v !== '') rows = rows.filter(r => String(r[k] ?? '').toLowerCase() === String(v).toLowerCase());
  return rows.sort((a, b) => String(a[TITLE[c]] || '').localeCompare(String(b[TITLE[c]] || '')));
}

// ---- Car math, shared with the site (app.js mirrors these exactly) ----
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const posMiles = v => { const n = v == null || v === '' ? NaN : Number(v); return Number.isFinite(n) && n > 0 ? n : null; }; // a usable odometer value, else null
const everyMilesOf = s => Number(s.everyMiles != null && s.everyMiles !== '' ? s.everyMiles : s.unit === 'miles' ? s.every : null) || null; // unit 'miles' is the legacy spelling of everyMiles
const baseline = s => s.lastMiles == null || s.lastMiles === '' ? NaN : Number(s.lastMiles); // the odometer when the task was last done; NaN when unknown or junk
// An asset's stored reading, when it is a positive mileage on a real date (an undated reading cannot be placed, so it does not count).
const stored = a => { const m = a ? posMiles(a.odometer) : null; return m && isYmd(a.odometerOn) ? { miles: m, on: a.odometerOn } : null; };
// Every reading for an asset, oldest first (same day: lower miles first): its stored reading plus each dated log entry carrying a positive mileage. Any asset may carry readings, not only cars.
const readings = (a, logs) => { const s = stored(a); return [...(s ? [s] : []), ...(logs || []).filter(l => a && l.asset === a.id && isYmd(l.date)).map(l => ({ miles: posMiles(l.mileage), on: l.date })).filter(r => r.miles)].sort((p, q) => p.on < q.on ? -1 : p.on > q.on ? 1 : p.miles - q.miles); };
// The latest reading { miles, on } (newest date; on a tie the higher miles), or null when the asset has none.
export function odometerOf(asset, logs) { const r = readings(asset, logs); return r.length ? r[r.length - 1] : null; }
// Miles per day from the first and last readings, when they are at least 30 days apart and the miles went up (clamped to 5..150); otherwise about 1,000 miles a month.
export function mileRate(asset, logs) {
  const r = readings(asset, logs);
  if (r.length > 1) { const first = r[0], last = r[r.length - 1], days = daysBetween(first.on, last.on); if (days >= 30 && last.miles > first.miles) return { perDay: Math.min(150, Math.max(5, (last.miles - first.miles) / days)), estimated: false }; }
  return { perDay: 33, estimated: true };
}
// When a task is due, by date and/or by miles. car is { miles, on, perDay } for the task's asset, or null.
export function dueInfo(s, car) {
  const days = s.nextDue ? daysUntil(s.nextDue) : null; const everyMiles = everyMilesOf(s);
  let milesLeft = null, estDays = null, needsOdometer = false, needsBaseline = false;
  if (everyMiles) {
    const last = baseline(s);
    if (!car) needsOdometer = true; else if (!Number.isFinite(last)) needsBaseline = true;
    else { milesLeft = Math.round(last + everyMiles - car.miles); const since = Math.max(0, daysBetween(car.on, today())); estDays = Math.round(milesLeft / car.perDay - since); if (milesLeft < 0) estDays = Math.min(estDays, -1); } // the reading is as of its date; the car has kept driving since
  }
  let eff = days, basis = days != null ? 'date' : null; if (estDays != null && (eff == null || estDays < eff)) { eff = estDays; basis = 'miles'; }
  return { days, milesLeft, estDays, eff, basis, everyMiles, needsOdometer, needsBaseline };
}
// Short label for a dueInfo: "in 1,200 mi · ~2027-01-15", "in 200 mi · about now", "300 mi over", "12d overdue", "today", "in 12d", a date, or why nothing can be said.
export function dueText(i) {
  if (i.basis === 'miles') return i.milesLeft < 0 ? `${fmtMiles(-i.milesLeft)} mi over` : `in ${fmtMiles(i.milesLeft)} mi${i.estDays <= 0 ? ' · about now' : i.estDays <= 60 ? ` · ~${addDays(today(), i.estDays)}` : ''}`;
  if (i.basis === 'date') return i.days < 0 ? `${-i.days}d overdue` : i.days === 0 ? 'today' : i.days <= 30 ? `in ${i.days}d` : addDays(today(), i.days);
  return i.needsOdometer ? 'needs an odometer reading' : i.needsBaseline ? 'set last done' : 'no date';
}
// Records a reading against an asset: the stored odometer moves when the reading is newer (or force). A reading below the latest known one and dated on or after it is kept but flagged; a backdated entry is not.
async function recordReading(a, miles, on, logs, force) {
  const prev = odometerOf(a, logs), was = stored(a); const newer = force || !was || on > was.on || (on === was.on && miles > was.miles);
  if (newer) await coll('assets').doc(a.id).update({ odometer: miles, odometerOn: on, updated: Date.now() });
  const latest = odometerOf(newer ? { ...a, odometer: miles, odometerOn: on } : a, [...logs, { asset: a.id, date: on, mileage: miles }]);
  return { previous: prev, latest, warning: prev && miles < prev.miles && on >= prev.on ? `${fmtMiles(miles)} mi is below the last known reading of ${fmtMiles(prev.miles)} mi on ${prev.on}.` : undefined };
}
// Sets an odometer outright (any asset is allowed, with a warning when it is not in area Car).
export async function setOdometer(assetQ, miles, date) {
  const m = positive(miles, 'miles'); if (m == null) throw new Error('miles is required: the odometer reading.'); const on = isoDate(date);
  const a = await find('assets', assetQ); const r = await recordReading(a, m, on, await all('log'), true);
  return clean({ asset: a.name, previous: r.previous, odometer: { miles: m, on }, warning: [!isCar(a) ? (a.parent ? `${a.name} is part of another asset, not a car of its own.` : `${a.name} is in area ${a.area || 'none'}, not Car.`) : null, r.warning].filter(Boolean).join(' ') || undefined });
}

export async function status() {
  const [sched, todos, assets, logs] = await Promise.all([all('schedule'), all('todos'), all('assets'), all('log')]);
  const name = id => (assets.find(a => a.id === id) || {}).name || null;
  const odo = new Map(assets.map(a => { const o = odometerOf(a, logs), r = mileRate(a, logs); return [a.id, { reading: o ? { ...o, perDay: r.perDay } : null, rate: r }]; })); // every asset, since a task is projected from its own asset's readings
  const cars = assets.filter(isCar).map(a => ({ id: a.id, name: a.name, ...odo.get(a.id) }));
  const rows = sched.map(s => { const i = dueInfo(s, (odo.get(s.asset) || {}).reading || null); return { id: s.id, task: s.task, asset: name(s.asset), assetId: s.asset || null, nextDue: s.nextDue || null, ...i, label: dueText(i) }; });
  const due = rows.filter(r => r.eff != null).sort((a, b) => a.eff - b.eff); const brief = r => ({ id: r.id, task: r.task, asset: r.asset });
  return {
    overdue: due.filter(r => r.eff < 0),
    dueSoon: due.filter(r => r.eff >= 0 && r.eff <= 30),
    openTodos: todos.filter(t => t.status !== 'done').map(t => ({ id: t.id, name: t.name, status: t.status || 'open', asset: name(t.asset), due: t.due || null, priority: t.priority || null })),
    cars: cars.map(c => { const next = due.find(r => r.assetId === c.id); return { name: c.name, id: c.id, odometer: c.reading ? c.reading.miles : null, readOn: c.reading ? c.reading.on : null, staleDays: c.reading ? -daysUntil(c.reading.on) : null, perDay: Math.round(c.rate.perDay * 10) / 10, estimatedRate: c.rate.estimated, nextUp: next ? { task: next.task, label: next.label } : null }; }),
    needsOdometer: rows.filter(r => r.needsOdometer).map(brief),
    needsBaseline: rows.filter(r => r.needsBaseline).map(brief),
    unscheduled: rows.filter(r => r.eff == null && !r.everyMiles).map(r => { const s = sched.find(s => s.id === r.id); return { ...brief(r), every: s.every, unit: s.unit }; }),
  };
}

export async function logWork({ item, asset, date, area, cost, doneBy, mileage, notes }) {
  const miles = positive(mileage, 'mileage'), paid = finite(cost, 'cost'), t = isoDate(date); const a = await findAsset(asset);
  const logs = a && miles != null ? await all('log') : null; // read before the new entry so the odometer check compares against prior readings; any asset's reading moves
  const d = await create('log', { item, date: t, area: area || (a ? a.area : null) || null, asset: a ? a.id : null, cost: paid, doneBy: doneBy || 'Me', mileage: miles, notes: notes || null });
  if (!logs) return d; const r = await recordReading(a, miles, t, logs); return clean({ ...d, odometer: r.latest, warning: r.warning });
}

// Mirrors the site's Done button: a log entry tagged with the schedule id; lastDone (and lastMiles when a reading is given) move to the completion; the next-due date rolls forward from it, or clears for a miles-only task so no stale date lingers.
export async function complete(q, { asset, date, cost, mileage, notes, doneBy } = {}) {
  const miles = positive(mileage, 'mileage'), paid = finite(cost, 'cost'), t = isoDate(date); const s = await findTask(q, asset);
  const a = s.asset ? (await all('assets')).find(x => x.id === s.asset) : null; const logs = a && miles != null ? await all('log') : null;
  await create('log', { item: s.task, date: t, area: s.area || null, asset: s.asset || null, doneBy: doneBy || 'Me', cost: paid, mileage: miles, notes: notes || null, schedule: s.id });
  const next = { lastDone: t, nextDue: s.every && s.unit !== 'miles' ? addInterval(t, Number(s.every), s.unit || 'months') : null }; if (miles != null) next.lastMiles = miles;
  await merge('schedule', s.id, next);
  const r = logs ? await recordReading(a, miles, t, logs) : null; const everyMiles = everyMilesOf(s), was = baseline(s), last = next.lastMiles ?? (Number.isFinite(was) ? was : null);
  const nextAtMiles = everyMiles && last != null ? last + everyMiles : null; const odo = r ? r.latest : a ? odometerOf(a, await all('log')) : null;
  return clean({ task: s.task, asset: a ? a.name : null, done: t, nextDue: next.nextDue, nextAtMiles, milesLeft: nextAtMiles != null && odo ? nextAtMiles - odo.miles : null, odometer: odo, warning: r ? r.warning : undefined });
}

export async function addTodo({ name, asset, due, priority, status, area, notes }) {
  const a = await findAsset(asset);
  return create('todos', { name, status: status || 'open', priority: priority || '', due: due || null, area: area || (a ? a.area : null) || null, asset: a ? a.id : null, notes: notes || null });
}

// every+unit is the time interval, everyMiles the mileage one; a car task may have either or both. unit 'miles' (legacy) becomes everyMiles and is never stored.
export async function addSchedule({ task, asset, every, unit, everyMiles, lastMiles, nextDue, lastDone, season, area, notes }) {
  let u = unit || null, n = positive(every, 'every', u === 'miles' ? 'miles' : u || 'months'), em = positive(everyMiles, 'everyMiles'); const lm = positive(lastMiles, 'lastMiles');
  if (u === 'miles') { em = em ?? n; n = null; u = null; }
  if (n == null && em == null) n = 12;
  const a = await findAsset(asset);
  return create('schedule', { task, area: area || (a ? a.area : null) || 'House', asset: a ? a.id : null, every: n, unit: u || 'months', everyMiles: em, lastMiles: lm, nextDue: nextDue || null, lastDone: lastDone || null, season: season || null, notes: notes || null });
}

export async function layout() { await init(); return (await mapRef().get()).data() || { floors: [{ id: 'main', name: 'Main floor' }], rooms: [], doors: [] }; }
// Components are assigned to a room by name (map:{floor, room}); the site lays them out inside it. Hand-pinned ones carry x,y instead.
export function roomRef(rooms, name) { const key = String(name || '').trim().toLowerCase(); const r = rooms.find(r => String(r.name || '').trim().toLowerCase() === key); return r ? { floor: r.floor, room: key } : null; }
export async function addAsset({ name, area, type, make, serial, year, purchased, specs, contact, manual, notes, room }) {
  let map = null, placedIn = null;
  if (room) { const m = await layout(); map = roomRef(m.rooms || [], room); placedIn = map ? room : null; }
  const doc = await create('assets', { name, area: area || 'House', type: type || null, make: make || null, serial: serial || null, year: finite(year, 'year'), purchased: purchased || null, specs: specs || null, contact: contact || null, manual: manual || null, notes: notes || '', map });
  return { ...doc, placedIn };
}
// facing (optional): which way a car or other long object points: n (toward the back of the map), s (toward the viewer), e, w. Outdoors a car faces n by default.
export async function place(assetQ, room, facing) {
  const a = await find('assets', assetQ); const m = await layout();
  const ref = roomRef(m.rooms || [], room); if (!ref) throw new Error(`No room named "${room}" on the map. Rooms: ${[...new Set((m.rooms || []).map(r => r.name))].join(', ')}`);
  if (facing && !['n', 's', 'e', 'w'].includes(facing)) throw new Error('facing must be n, s, e or w'); if (facing || (a.map && a.map.facing)) ref.facing = facing || a.map.facing; // moving a car keeps the way it points
  await coll('assets').doc(a.id).update({ map: ref, updated: Date.now() }); return { asset: a.name, room, floor: ref.floor, facing: ref.facing || null }; // update() replaces the map field; set-merge would keep old x,y
}
// A door sits on a wall of room r when it lies on one of r's edges, strictly inside that edge (the site's test; doors on no wall are pruned on save).
export const onWall = (d, r) => d.dir === 'h' ? (r.y === d.y || r.y + r.h === d.y) && d.x > r.x && d.x < r.x + r.w : (r.x === d.x || r.x + r.w === d.x) && d.y > r.y && d.y < r.y + r.h;
const hasWall = (rooms, d) => (rooms || []).some(r => r.floor === d.floor && onWall(d, r));
export async function saveLayout(patch) { await init(); const m = await layout(); const next = { ...m, ...patch, id: 'layout', updated: Date.now() }; next.doors = (next.doors || []).filter(d => hasWall(next.rooms, d)); await mapRef().set(next); return next; }
// A room piece: same-named pieces join into one room; kind 'outdoor' is paved ground with no walls (driveway, patio). Units: about 11 per foot.
export async function addRoom({ name, x, y, w, h, color, kind, floor }) {
  const m = await layout(); const f = floor || (m.floors && m.floors[0] ? m.floors[0].id : 'main'); const key = String(name).trim().toLowerCase();
  const twin = (m.rooms || []).find(r => r.floor === f && String(r.name || '').trim().toLowerCase() === key);
  const r = { id: uid(), floor: f, name: String(name).trim(), x: Number(x), y: Number(y), w: Number(w), h: Number(h), color: color != null ? Number(color) : twin ? (twin.color ?? 0) : (m.rooms || []).length % 6 };
  if (kind === 'outdoor' || (kind == null && twin && twin.kind === 'outdoor')) r.kind = 'outdoor';
  await saveLayout({ rooms: [...(m.rooms || []), r] }); return r;
}
// Removing the last piece of a room on a floor unplaces the components assigned to it (map: null) instead of losing them; doors left on no wall go too.
export async function removeRoom(q) {
  const m = await layout(); const rk = r => String(r.name || '').trim().toLowerCase(); const key = String(q).trim().toLowerCase(); const gone = (m.rooms || []).filter(r => r.id === q || rk(r) === key);
  if (!gone.length) throw new Error(`No room "${q}". Rooms: ${[...new Set((m.rooms || []).map(r => r.name))].join(', ')}`);
  const rooms = m.rooms.filter(r => !gone.includes(r)); const lost = gone.filter(g => !rooms.some(r => r.floor === g.floor && rk(r) === rk(g)));
  const orphans = lost.length ? (await all('assets')).filter(a => a.map && a.map.room && lost.some(g => g.floor === a.map.floor && rk(g) === String(a.map.room).toLowerCase())) : [];
  const saved = await saveLayout({ rooms }); for (const a of orphans) await coll('assets').doc(a.id).update({ map: null, updated: Date.now() });
  return { removed: gone, unplaced: orphans.map(a => a.name), doorsRemoved: (m.doors || []).length - (saved.doors || []).length };
}
export async function addDoor({ x, y, dir, w, floor }) {
  const m = await layout(); const d = { id: uid(), floor: floor || (m.floors && m.floors[0] ? m.floors[0].id : 'main'), x: Number(x), y: Number(y), dir: dir === 'v' ? 'v' : 'h', w: Number(w) || 36 };
  if (!hasWall(m.rooms, d)) throw new Error(`No ${d.dir === 'h' ? 'left-right' : 'up-down'} wall passes through ${d.x},${d.y} on floor ${d.floor}; a door must sit on a room's edge.`);
  await saveLayout({ doors: [...(m.doors || []), d] }); return d;
}
export async function removeDoor(id) { const m = await layout(); const d = (m.doors || []).find(d => d.id === id); if (!d) throw new Error(`No door ${id}`); await saveLayout({ doors: m.doors.filter(x => x.id !== id) }); return d; }
// Docking: a part installed in another asset (surge protector in the panel, filter in the furnace) rides with it on the map and rolls its status up.
export async function dock(assetQ, parentQ) {
  const a = await find('assets', assetQ); const p = parentQ ? await find('assets', parentQ) : null;
  if (p) { if (p.id === a.id) throw new Error('An asset cannot be installed in itself.'); let q = p; for (let i = 0; q && i < 12; i++) { if (q.parent === a.id) throw new Error(`${p.name} is already inside ${a.name}.`); q = q.parent ? (await all('assets')).find(x => x.id === q.parent) : null; } }
  await coll('assets').doc(a.id).update({ parent: p ? p.id : null, ...(p ? { map: null } : {}), updated: Date.now() });
  return { asset: a.name, in: p ? p.name : null };
}
export async function turn(assetQ, facing) {
  const a = await find('assets', assetQ); if (!a.map) throw new Error(`${a.name} is not on the map; place it first.`); if (!['n', 's', 'e', 'w'].includes(facing)) throw new Error('facing must be n, s, e or w');
  await coll('assets').doc(a.id).update({ map: { ...a.map, facing }, updated: Date.now() }); return { asset: a.name, facing };
}
export async function mapSummary() {
  const m = await layout(); const assets = await all('assets'); const floors = m.floors || [{ id: 'main', name: 'Main floor' }];
  return { floors: floors.map(f => ({ ...f, rooms: (m.rooms || []).filter(r => r.floor === f.id).map(r => ({ id: r.id, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h, color: r.color ?? 0 })), doors: (m.doors || []).filter(d => d.floor === f.id), assets: assets.filter(a => a.map && a.map.floor === f.id).map(a => ({ id: a.id, name: a.name, parts: assets.filter(c => c.parent === a.id).map(c => c.name), room: a.map.room || ((m.rooms || []).find(r => r.floor === f.id && a.map.x >= r.x && a.map.x <= r.x + r.w && a.map.y >= r.y && a.map.y <= r.y + r.h) || {}).name || null, pinned: a.map.x != null ? [a.map.x, a.map.y] : null })) })), unplaced: assets.filter(a => !a.map && !(a.parent && assets.some(p => p.id === a.parent && p.map))).map(a => a.name) };
}
export async function dump() { const out = {}; for (const c of COLLS) out[c] = await all(c); out.map = await layout(); return out; }

// Household access list: access/{email} -> { owner } lets that Google account open the owner's data (the rules check it).
export async function share(email) { await init(); const e = String(email).trim().toLowerCase(); await db.collection('access').doc(e).set({ owner: UID, email: e, added: Date.now() }); return e; }
export async function unshare(email) { await init(); const e = String(email).trim().toLowerCase(); await db.collection('access').doc(e).delete(); return e; }
export async function shares() { await init(); return (await db.collection('access').get()).docs.map(d => d.data()); }
