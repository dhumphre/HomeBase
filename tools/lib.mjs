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
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const addInterval = (s, n, unit) => { const d = new Date(`${s}T12:00:00`); if (unit === 'weeks') d.setDate(d.getDate() + 7 * n); else if (unit === 'years') d.setFullYear(d.getFullYear() + n); else d.setMonth(d.getMonth() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const daysUntil = s => s ? Math.round((new Date(`${s}T12:00:00`) - new Date(`${today()}T12:00:00`)) / 864e5) : null;
export const slugify = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'page';
const num = v => v == null || v === '' ? null : Number(v);
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

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
export async function remove(c, q) { const r = await find(c, q); await coll(c).doc(r.id).delete(); return r; }

// One document by id, exact title, or a unique case-insensitive substring of the title.
export async function find(c, q) {
  const rows = await all(c); const t = TITLE[c]; const needle = String(q).toLowerCase();
  const byId = rows.find(r => r.id === q); if (byId) return byId;
  const exact = rows.filter(r => String(r[t] || '').toLowerCase() === needle); if (exact.length === 1) return exact[0];
  const part = rows.filter(r => String(r[t] || '').toLowerCase().includes(needle));
  if (part.length === 1) return part[0];
  if (!part.length) throw new Error(`No ${c.replace(/s$/, '')} matches "${q}".`);
  throw new Error(`"${q}" matches several ${c}: ${part.map(r => `${r[t]} (${r.id})`).join('; ')}`);
}
export const findAsset = async q => q ? find('assets', q) : null;

export async function list(c, filters = {}) {
  let rows = await all(c);
  for (const [k, v] of Object.entries(filters)) if (v != null && v !== '') rows = rows.filter(r => String(r[k] ?? '').toLowerCase() === String(v).toLowerCase());
  return rows.sort((a, b) => String(a[TITLE[c]] || '').localeCompare(String(b[TITLE[c]] || '')));
}

export async function status() {
  const [sched, todos, assets] = await Promise.all([all('schedule'), all('todos'), all('assets')]);
  const name = id => (assets.find(a => a.id === id) || {}).name || null;
  const due = sched.filter(s => s.nextDue).map(s => ({ id: s.id, task: s.task, asset: name(s.asset), nextDue: s.nextDue, days: daysUntil(s.nextDue) })).sort((a, b) => a.days - b.days);
  return {
    overdue: due.filter(s => s.days < 0),
    dueSoon: due.filter(s => s.days >= 0 && s.days <= 30),
    openTodos: todos.filter(t => t.status !== 'done').map(t => ({ id: t.id, name: t.name, status: t.status || 'open', asset: name(t.asset), due: t.due || null, priority: t.priority || null })),
    unscheduled: sched.filter(s => !s.nextDue).map(s => ({ id: s.id, task: s.task, asset: name(s.asset), every: s.every, unit: s.unit })),
  };
}

export async function logWork({ item, asset, date, area, cost, doneBy, mileage, notes }) {
  const a = await findAsset(asset);
  return create('log', { item, date: date || today(), area: area || (a ? a.area : null) || null, asset: a ? a.id : null, cost: num(cost), doneBy: doneBy || 'Me', mileage: num(mileage), notes: notes || null });
}

// Mirrors the site's Done button: a log entry, then the next-due date rolls forward from the completion date.
export async function complete(q, { date, cost, mileage, notes, doneBy } = {}) {
  const s = await find('schedule', q); const t = date || today();
  const a = s.asset ? (await all('assets')).find(x => x.id === s.asset) : null;
  await create('log', { item: s.task, date: t, area: s.area || null, asset: s.asset || null, doneBy: doneBy || 'Me', cost: num(cost), mileage: num(mileage), notes: notes || null });
  const next = { lastDone: t }; if (s.unit !== 'miles' && s.every) next.nextDue = addInterval(t, Number(s.every), s.unit || 'months');
  await merge('schedule', s.id, next);
  return { task: s.task, asset: a ? a.name : null, done: t, nextDue: next.nextDue || null };
}

export async function addTodo({ name, asset, due, priority, status, area, notes }) {
  const a = await findAsset(asset);
  return create('todos', { name, status: status || 'open', priority: priority || '', due: due || null, area: area || (a ? a.area : null) || null, asset: a ? a.id : null, notes: notes || null });
}

export async function addSchedule({ task, asset, every, unit, nextDue, lastDone, season, area, notes }) {
  const a = await findAsset(asset);
  return create('schedule', { task, area: area || (a ? a.area : null) || 'House', asset: a ? a.id : null, every: num(every) ?? 12, unit: unit || 'months', nextDue: nextDue || null, lastDone: lastDone || null, season: season || null, notes: notes || null });
}

export async function layout() { await init(); return (await mapRef().get()).data() || { floors: [{ id: 'main', name: 'Main floor' }], rooms: [], doors: [] }; }
// Components are assigned to a room by name (map:{floor, room}); the site lays them out inside it. Hand-pinned ones carry x,y instead.
export function roomRef(rooms, name) { const key = String(name || '').trim().toLowerCase(); const r = rooms.find(r => String(r.name || '').trim().toLowerCase() === key); return r ? { floor: r.floor, room: key } : null; }
export async function addAsset({ name, area, type, make, serial, year, purchased, specs, contact, manual, notes, room }) {
  let map = null, placedIn = null;
  if (room) { const m = await layout(); map = roomRef(m.rooms || [], room); placedIn = map ? room : null; }
  const doc = await create('assets', { name, area: area || 'House', type: type || null, make: make || null, serial: serial || null, year: num(year), purchased: purchased || null, specs: specs || null, contact: contact || null, manual: manual || null, notes: notes || '', map });
  return { ...doc, placedIn };
}
// facing (optional): which way a car or other long object points: n (toward the back of the map), s (toward the viewer), e, w. Outdoors a car faces n by default.
export async function place(assetQ, room, facing) {
  const a = await find('assets', assetQ); const m = await layout();
  const ref = roomRef(m.rooms || [], room); if (!ref) throw new Error(`No room named "${room}" on the map. Rooms: ${[...new Set((m.rooms || []).map(r => r.name))].join(', ')}`);
  if (facing && !['n', 's', 'e', 'w'].includes(facing)) throw new Error('facing must be n, s, e or w'); if (facing) ref.facing = facing;
  await coll('assets').doc(a.id).update({ map: ref, updated: Date.now() }); return { asset: a.name, room, floor: ref.floor, facing: facing || null }; // update() replaces the map field; set-merge would keep old x,y
}
export async function saveLayout(patch) { await init(); const m = await layout(); const next = { ...m, ...patch, id: 'layout', updated: Date.now() }; await mapRef().set(next); return next; }
// A room piece: same-named pieces join into one room; kind 'outdoor' is paved ground with no walls (driveway, patio). Units: about 11 per foot.
export async function addRoom({ name, x, y, w, h, color, kind, floor }) {
  const m = await layout(); const f = floor || (m.floors && m.floors[0] ? m.floors[0].id : 'main'); const key = String(name).trim().toLowerCase();
  const twin = (m.rooms || []).find(r => r.floor === f && String(r.name || '').trim().toLowerCase() === key);
  const r = { id: uid(), floor: f, name: String(name).trim(), x: Number(x), y: Number(y), w: Number(w), h: Number(h), color: color != null ? Number(color) : twin ? (twin.color ?? 0) : (m.rooms || []).length % 6 };
  if (kind === 'outdoor' || (kind == null && twin && twin.kind === 'outdoor')) r.kind = 'outdoor';
  await saveLayout({ rooms: [...(m.rooms || []), r] }); return r;
}
export async function removeRoom(q) {
  const m = await layout(); const key = String(q).trim().toLowerCase(); const gone = (m.rooms || []).filter(r => r.id === q || String(r.name || '').trim().toLowerCase() === key);
  if (!gone.length) throw new Error(`No room "${q}". Rooms: ${[...new Set((m.rooms || []).map(r => r.name))].join(', ')}`);
  await saveLayout({ rooms: m.rooms.filter(r => !gone.includes(r)) }); return gone;
}
export async function addDoor({ x, y, dir, w, floor }) {
  const m = await layout(); const d = { id: uid(), floor: floor || (m.floors && m.floors[0] ? m.floors[0].id : 'main'), x: Number(x), y: Number(y), dir: dir === 'v' ? 'v' : 'h', w: Number(w) || 36 };
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
export async function mapSummary() {
  const m = await layout(); const assets = await all('assets'); const floors = m.floors || [{ id: 'main', name: 'Main floor' }];
  return { floors: floors.map(f => ({ ...f, rooms: (m.rooms || []).filter(r => r.floor === f.id).map(r => ({ id: r.id, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h, color: r.color ?? 0 })), doors: (m.doors || []).filter(d => d.floor === f.id), assets: assets.filter(a => a.map && a.map.floor === f.id).map(a => ({ id: a.id, name: a.name, parts: assets.filter(c => c.parent === a.id).map(c => c.name), room: a.map.room || ((m.rooms || []).find(r => r.floor === f.id && a.map.x >= r.x && a.map.x <= r.x + r.w && a.map.y >= r.y && a.map.y <= r.y + r.h) || {}).name || null, pinned: a.map.x != null ? [a.map.x, a.map.y] : null })) })), unplaced: assets.filter(a => !a.map && !(a.parent && assets.some(p => p.id === a.parent && p.map))).map(a => a.name) };
}
export async function dump() { const out = {}; for (const c of COLLS) out[c] = await all(c); out.map = await layout(); return out; }

// Household access list: access/{email} -> { owner } lets that Google account open the owner's data (the rules check it).
export async function share(email) { await init(); const e = String(email).trim().toLowerCase(); await db.collection('access').doc(e).set({ owner: UID, email: e, added: Date.now() }); return e; }
export async function unshare(email) { await init(); const e = String(email).trim().toLowerCase(); await db.collection('access').doc(e).delete(); return e; }
export async function shares() { await init(); return (await db.collection('access').get()).docs.map(d => d.data()); }
