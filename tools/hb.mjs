#!/usr/bin/env node
// Command-line access to the Home Base data in Firestore, for Claude Code (or a terminal).
// Needs a Firebase service-account key kept OUTSIDE the repo:
//   %USERPROFILE%\.homebase\service-account.json   (or set HB_SERVICE_ACCOUNT to another path)
// The data belongs to the one Google user of the project; set HB_EMAIL if there is ever more than one.
//
//   node tools/hb.mjs status                         what is overdue, due soon, open
//   node tools/hb.mjs ls <coll> [key=value ...]      assets | log | schedule | todos | projects | pages
//   node tools/hb.mjs get <coll> <id>
//   node tools/hb.mjs add <coll> '<json>'            new document (id, created, updated filled in); '@file.json' reads it from a file
//   node tools/hb.mjs set <coll> <id> '<json>'       merge fields into a document
//   node tools/hb.mjs rm <coll> <id>
//   node tools/hb.mjs log "<what>" [--asset <name|id>] [--date YYYY-MM-DD] [--cost 120] [--mileage 48210] [--by "Dealer or shop"] [--notes "..."]
//   node tools/hb.mjs done "<task or id>" [--date YYYY-MM-DD] [--mileage n] [--notes "..."]   logs it and rolls the next-due date
//   node tools/hb.mjs todo "<name>" [--asset <name|id>] [--due YYYY-MM-DD] [--priority high] [--notes "..."]
//   node tools/hb.mjs asset "<name>" [--area House] [--type "Water heater"] [--make "Rheem"] [--year 2019] [--specs "..."] [--room Garage]
//   node tools/hb.mjs schedule "<task>" --asset <name|id> --every 6 --unit months [--next YYYY-MM-DD] [--notes "..."]
//   node tools/hb.mjs place <asset name|id> <room name>    put a component in a room on the map
//   node tools/hb.mjs map                                   floors, rooms, doors and placed components
//   node tools/hb.mjs dump                                  everything as JSON
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const COLLS = ['assets', 'log', 'schedule', 'todos', 'projects', 'pages'];
const TITLE = { assets: 'name', log: 'item', schedule: 'task', todos: 'name', projects: 'name', pages: 'title' };
const keyPath = process.env.HB_SERVICE_ACCOUNT || join(homedir(), '.homebase', 'service-account.json');
if (!existsSync(keyPath)) { console.error(`No service-account key at ${keyPath}.\nFirebase console > Project settings > Service accounts > Generate new private key, save it there.`); process.exit(2); }
initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

const uid = () => randomUUID().replace(/-/g, '').slice(0, 20);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addInterval = (s, n, unit) => { const d = new Date(`${s}T12:00:00`); if (unit === 'weeks') d.setDate(d.getDate() + 7 * n); else if (unit === 'years') d.setFullYear(d.getFullYear() + n); else d.setMonth(d.getMonth() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const daysUntil = s => s ? Math.round((new Date(`${s}T12:00:00`) - new Date(`${today()}T12:00:00`)) / 864e5) : null;
const slugify = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'page';

// ---- args: positionals plus --flag value pairs
const argv = process.argv.slice(2); const pos = []; const opt = {};
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { opt[k] = v; i++; } else opt[k] = true; } else pos.push(a); }
const [cmd, ...rest] = pos;
const json = v => JSON.parse(v.startsWith('@') ? readFileSync(v.slice(1), 'utf8') : v); // '@file.json' reads the JSON from a file

async function userId() {
  if (process.env.HB_UID) return process.env.HB_UID;
  const auth = getAuth();
  if (process.env.HB_EMAIL) return (await auth.getUserByEmail(process.env.HB_EMAIL)).uid;
  const { users } = await auth.listUsers(5);
  if (users.length === 1) return users[0].uid;
  console.error('More than one user in the project; set HB_EMAIL or HB_UID.'); users.forEach(u => console.error(`  ${u.uid}  ${u.email}`)); process.exit(2);
}
const UID = await userId();
const coll = c => db.collection('users').doc(UID).collection(c);
const mapRef = () => db.collection('users').doc(UID).collection('map').doc('layout');
async function all(c) { const snap = await coll(c).get(); return snap.docs.map(d => d.data()); }
function checkColl(c) { if (!COLLS.includes(c)) { console.error(`Collection must be one of ${COLLS.join(', ')}`); process.exit(2); } }
async function create(c, data) { const id = uid(); const now = Date.now(); const doc = { ...data, id, created: now, updated: now }; if (c === 'pages' && !doc.slug) doc.slug = slugify(doc.title); await coll(c).doc(id).set(doc); return doc; }
async function merge(c, id, data) { await coll(c).doc(id).set({ ...data, updated: Date.now() }, { merge: true }); }
const num = v => v == null || v === '' ? null : Number(v);

// Find one document by id, exact title, or unique case-insensitive substring of the title.
async function find(c, q) {
  const rows = await all(c); const t = TITLE[c]; const needle = String(q).toLowerCase();
  const byId = rows.find(r => r.id === q); if (byId) return byId;
  const exact = rows.filter(r => String(r[t] || '').toLowerCase() === needle); if (exact.length === 1) return exact[0];
  const part = rows.filter(r => String(r[t] || '').toLowerCase().includes(needle));
  if (part.length === 1) return part[0];
  if (!part.length) { console.error(`No ${c.replace(/s$/, '')} matches "${q}".`); process.exit(1); }
  console.error(`"${q}" matches several: ${part.map(r => `${r[t]} (${r.id})`).join('; ')}`); process.exit(1);
}
const roomCenter = (rooms, name) => { const rs = rooms.filter(r => String(r.name || '').toLowerCase() === name.toLowerCase()); if (!rs.length) return null; const r = rs.sort((a, b) => b.w * b.h - a.w * a.h)[0]; return { floor: r.floor, x: Math.round((r.x + r.w / 2) / 10) * 10, y: Math.round((r.y + r.h / 2) / 10) * 10 }; };
const show = o => console.log(JSON.stringify(o, null, 2));
const line = (c, r) => { const t = r[TITLE[c]]; const extra = c === 'schedule' ? ` next ${r.nextDue || '—'} every ${r.every} ${r.unit}` : c === 'log' ? ` ${r.date}` : c === 'todos' ? ` [${r.status || 'open'}]${r.due ? ' due ' + r.due : ''}` : c === 'assets' ? ` ${[r.area, r.type, r.make].filter(Boolean).join(' · ')}` : ''; return `${r.id}  ${t}${extra}${r.asset ? `  asset:${r.asset}` : ''}`; };

switch (cmd) {
  case 'status': {
    const [sched, todos, assets] = await Promise.all([all('schedule'), all('todos'), all('assets')]);
    const name = id => (assets.find(a => a.id === id) || {}).name;
    const due = sched.filter(s => s.nextDue).map(s => ({ ...s, days: daysUntil(s.nextDue) })).sort((a, b) => a.days - b.days);
    console.log('Overdue:'); due.filter(s => s.days < 0).forEach(s => console.log(`  ${-s.days}d  ${s.task}${s.asset ? ` (${name(s.asset)})` : ''}  ${s.id}`));
    console.log('Due within 30 days:'); due.filter(s => s.days >= 0 && s.days <= 30).forEach(s => console.log(`  ${s.days}d  ${s.task}${s.asset ? ` (${name(s.asset)})` : ''}  ${s.id}`));
    console.log('Open to-dos:'); todos.filter(t => t.status !== 'done').forEach(t => console.log(`  [${t.status || 'open'}] ${t.name}${t.asset ? ` (${name(t.asset)})` : ''}${t.due ? ' due ' + t.due : ''}  ${t.id}`));
    console.log(`Unscheduled (no next-due date): ${sched.filter(s => !s.nextDue).length}`);
    break;
  }
  case 'ls': { const c = rest[0]; checkColl(c); let rows = await all(c); for (const f of rest.slice(1)) { const [k, v] = f.split('='); rows = rows.filter(r => String(r[k] ?? '').toLowerCase() === String(v).toLowerCase()); } rows.sort((a, b) => String(a[TITLE[c]] || '').localeCompare(String(b[TITLE[c]] || ''))); rows.forEach(r => console.log(line(c, r))); console.log(`${rows.length} ${c}`); break; }
  case 'get': { checkColl(rest[0]); show(await find(rest[0], rest[1])); break; }
  case 'add': { checkColl(rest[0]); const doc = await create(rest[0], json(rest[1])); console.log(`Added ${rest[0]} ${doc.id}`); break; }
  case 'set': { checkColl(rest[0]); const r = await find(rest[0], rest[1]); await merge(rest[0], r.id, json(rest[2])); console.log(`Updated ${rest[0]} ${r.id}`); break; }
  case 'rm': { checkColl(rest[0]); const r = await find(rest[0], rest[1]); await coll(rest[0]).doc(r.id).delete(); console.log(`Deleted ${rest[0]} ${r.id} (${r[TITLE[rest[0]]]})`); break; }
  case 'log': {
    const asset = opt.asset ? await find('assets', opt.asset) : null;
    const doc = await create('log', { item: rest[0], date: opt.date || today(), area: opt.area || (asset ? asset.area : null) || null, asset: asset ? asset.id : null, cost: num(opt.cost), doneBy: opt.by || 'Me', mileage: num(opt.mileage), notes: opt.notes || null });
    console.log(`Logged "${doc.item}" on ${doc.date}${asset ? ` for ${asset.name}` : ''} (${doc.id})`); break;
  }
  case 'done': {
    const s = await find('schedule', rest[0]); const t = opt.date || today();
    const asset = s.asset ? (await all('assets')).find(a => a.id === s.asset) : null;
    await create('log', { item: s.task, date: t, area: s.area || null, asset: s.asset || null, doneBy: opt.by || 'Me', cost: num(opt.cost), mileage: num(opt.mileage), notes: opt.notes || null });
    const next = { lastDone: t }; if (s.unit !== 'miles' && s.every) next.nextDue = addInterval(t, Number(s.every), s.unit || 'months');
    await merge('schedule', s.id, next);
    console.log(`Logged "${s.task}"${asset ? ` for ${asset.name}` : ''}; next due ${next.nextDue || 'by mileage'}`); break;
  }
  case 'todo': { const asset = opt.asset ? await find('assets', opt.asset) : null; const doc = await create('todos', { name: rest[0], status: opt.status || 'open', priority: opt.priority || '', due: opt.due || null, area: opt.area || (asset ? asset.area : null) || null, asset: asset ? asset.id : null, notes: opt.notes || null }); console.log(`Added to-do "${doc.name}" (${doc.id})`); break; }
  case 'asset': {
    const m = (await mapRef().get()).data() || {}; const map = opt.room ? roomCenter(m.rooms || [], opt.room) : null;
    if (opt.room && !map) console.error(`No room named "${opt.room}" on the map; adding the asset unplaced.`);
    const doc = await create('assets', { name: rest[0], area: opt.area || 'House', type: opt.type || null, make: opt.make || null, serial: opt.serial || null, year: num(opt.year), purchased: opt.purchased || null, specs: opt.specs || null, contact: opt.contact || null, manual: opt.manual || null, notes: opt.notes || '', map });
    console.log(`Added asset "${doc.name}" (${doc.id})${map ? ` in ${opt.room}` : ''}`); break;
  }
  case 'schedule': { const asset = opt.asset ? await find('assets', opt.asset) : null; const doc = await create('schedule', { task: rest[0], area: opt.area || (asset ? asset.area : null) || 'House', asset: asset ? asset.id : null, every: num(opt.every) ?? 12, unit: opt.unit || 'months', nextDue: opt.next || null, lastDone: opt.last || null, season: opt.season || null, notes: opt.notes || null }); console.log(`Scheduled "${doc.task}" every ${doc.every} ${doc.unit}${doc.nextDue ? `, next ${doc.nextDue}` : ''} (${doc.id})`); break; }
  case 'place': { const a = await find('assets', rest[0]); const m = (await mapRef().get()).data() || {}; const map = roomCenter(m.rooms || [], rest[1]); if (!map) { console.error(`No room named "${rest[1]}".`); process.exit(1); } await merge('assets', a.id, { map }); console.log(`${a.name} placed in ${rest[1]}`); break; }
  case 'map': { const m = (await mapRef().get()).data() || {}; const assets = await all('assets'); const floors = m.floors || [{ id: 'main', name: 'Main floor' }]; for (const f of floors) { console.log(`${f.name} (${f.id})`); for (const r of (m.rooms || []).filter(r => r.floor === f.id)) console.log(`  room ${r.name}  x${r.x} y${r.y} w${r.w} h${r.h}  color ${r.color ?? 0}  ${r.id}`); for (const d of (m.doors || []).filter(d => d.floor === f.id)) console.log(`  door ${d.dir} at ${d.x},${d.y} w${d.w}  ${d.id}`); for (const a of assets.filter(a => a.map && a.map.floor === f.id)) console.log(`  asset ${a.name} at ${a.map.x},${a.map.y}  ${a.id}`); } console.log(`Unplaced: ${assets.filter(a => !a.map).map(a => a.name).join(', ') || 'none'}`); break; }
  case 'dump': { const out = {}; for (const c of COLLS) out[c] = await all(c); out.map = (await mapRef().get()).data() || null; show(out); break; }
  default: console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
}
