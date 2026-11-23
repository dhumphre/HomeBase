#!/usr/bin/env node
// Command-line access to the Home Base data, for Claude Code or a terminal. Same data layer as the MCP server (mcp.mjs).
// Needs a service-account key kept OUTSIDE the repo: %USERPROFILE%\.homebase\service-account.json (or HB_SERVICE_ACCOUNT=<path>).
//
//   node tools/hb.mjs status                         what is overdue, due soon, open
//   node tools/hb.mjs ls <coll> [key=value ...]      assets | log | schedule | todos | projects | pages
//   node tools/hb.mjs get <coll> <id or name>
//   node tools/hb.mjs add <coll> '<json>'            new document; '@file.json' reads it from a file
//   node tools/hb.mjs set <coll> <id or name> '<json>'   merge fields into a document
//   node tools/hb.mjs rm <coll> <id or name>
//   node tools/hb.mjs log "<what>" [--asset <name>] [--date YYYY-MM-DD] [--cost 120] [--mileage 48210] [--by "Dealer or shop"] [--notes "..."]
//   node tools/hb.mjs done "<task or id>" [--date YYYY-MM-DD] [--mileage n] [--notes "..."]   logs it and rolls the next-due date
//   node tools/hb.mjs todo "<name>" [--asset <name>] [--due YYYY-MM-DD] [--priority high] [--notes "..."]
//   node tools/hb.mjs asset "<name>" [--area House] [--type "Water heater"] [--make Rheem] [--year 2019] [--specs "..."] [--room Garage]
//   node tools/hb.mjs schedule "<task>" --asset <name> --every 6 --unit months [--next YYYY-MM-DD] [--notes "..."]
//   node tools/hb.mjs place <asset> <room>           put a component in a room on the map
//   node tools/hb.mjs room "<name>" --x 820 --y 350 --w 200 --h 250 [--color 0-5] [--outdoor]   add a room piece (about 11 units per foot)
//   node tools/hb.mjs rmroom <name or id>            remove a room (every piece of that name)
//   node tools/hb.mjs door --x 880 --y 340 --dir h [--w 36|120]   a door (w 120 = wide opening / garage door) on a wall at that point
//   node tools/hb.mjs map                            floors, rooms, doors and placed components
//   node tools/hb.mjs share <email> | unshare <email> | shares     the household access list
//   node tools/hb.mjs dump                           everything as JSON
import { readFileSync } from 'node:fs';
import * as hb from './lib.mjs';

const argv = process.argv.slice(2); const pos = []; const opt = {};
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { opt[k] = v; i++; } else opt[k] = true; } else pos.push(a); }
const [cmd, ...rest] = pos;
const json = v => JSON.parse(v.startsWith('@') ? readFileSync(v.slice(1), 'utf8') : v);
const show = o => console.log(JSON.stringify(o, null, 2));
const line = (c, r) => { const t = r[hb.TITLE[c]]; const extra = c === 'schedule' ? ` next ${r.nextDue || '—'} every ${r.every} ${r.unit}` : c === 'log' ? ` ${r.date}` : c === 'todos' ? ` [${r.status || 'open'}]${r.due ? ' due ' + r.due : ''}` : c === 'assets' ? ` ${[r.area, r.type, r.make].filter(Boolean).join(' · ')}` : ''; return `${r.id}  ${t}${extra}${r.asset ? `  asset:${r.asset}` : ''}`; };

try {
  switch (cmd) {
    case 'status': { const s = await hb.status(); const row = x => `  ${x.days != null ? `${x.days < 0 ? -x.days + 'd overdue' : x.days + 'd'}  ` : ''}${x.task || x.name}${x.asset ? ` (${x.asset})` : ''}  ${x.id}`; console.log('Overdue:'); s.overdue.forEach(x => console.log(row(x))); console.log('Due within 30 days:'); s.dueSoon.forEach(x => console.log(row(x))); console.log('Open to-dos:'); s.openTodos.forEach(x => console.log(`  [${x.status}] ${x.name}${x.asset ? ` (${x.asset})` : ''}${x.due ? ' due ' + x.due : ''}  ${x.id}`)); console.log(`No next-due date yet: ${s.unscheduled.length}`); break; }
    case 'ls': { const c = hb.checkColl(rest[0]); const f = Object.fromEntries(rest.slice(1).map(x => x.split('='))); const rows = await hb.list(c, f); rows.forEach(r => console.log(line(c, r))); console.log(`${rows.length} ${c}`); break; }
    case 'get': show(await hb.find(hb.checkColl(rest[0]), rest[1])); break;
    case 'add': { const d = await hb.create(hb.checkColl(rest[0]), json(rest[1])); console.log(`Added ${rest[0]} ${d.id}`); break; }
    case 'set': { const c = hb.checkColl(rest[0]); const r = await hb.find(c, rest[1]); await hb.merge(c, r.id, json(rest[2])); console.log(`Updated ${c} ${r.id}`); break; }
    case 'rm': { const c = hb.checkColl(rest[0]); const r = await hb.remove(c, rest[1]); console.log(`Deleted ${c} ${r.id} (${r[hb.TITLE[c]]})`); break; }
    case 'log': { const d = await hb.logWork({ item: rest[0], asset: opt.asset, date: opt.date, area: opt.area, cost: opt.cost, doneBy: opt.by, mileage: opt.mileage, notes: opt.notes }); console.log(`Logged "${d.item}" on ${d.date} (${d.id})`); break; }
    case 'done': { const r = await hb.complete(rest[0], { date: opt.date, cost: opt.cost, mileage: opt.mileage, notes: opt.notes, doneBy: opt.by }); console.log(`Logged "${r.task}"${r.asset ? ` for ${r.asset}` : ''}; next due ${r.nextDue || 'by mileage'}`); break; }
    case 'todo': { const d = await hb.addTodo({ name: rest[0], asset: opt.asset, due: opt.due, priority: opt.priority, status: opt.status, area: opt.area, notes: opt.notes }); console.log(`Added to-do "${d.name}" (${d.id})`); break; }
    case 'asset': { const d = await hb.addAsset({ name: rest[0], ...opt }); console.log(`Added asset "${d.name}" (${d.id})${d.placedIn ? ` in ${d.placedIn}` : opt.room ? ` (no room named "${opt.room}", left unplaced)` : ''}`); break; }
    case 'schedule': { const d = await hb.addSchedule({ task: rest[0], asset: opt.asset, every: opt.every, unit: opt.unit, nextDue: opt.next, lastDone: opt.last, season: opt.season, area: opt.area, notes: opt.notes }); console.log(`Scheduled "${d.task}" every ${d.every} ${d.unit}${d.nextDue ? `, next ${d.nextDue}` : ''} (${d.id})`); break; }
    case 'place': { const r = await hb.place(rest[0], rest[1]); console.log(`${r.asset} placed in ${r.room}`); break; }
    case 'room': { const r = await hb.addRoom({ name: rest[0], x: opt.x, y: opt.y, w: opt.w, h: opt.h, color: opt.color, kind: opt.outdoor ? 'outdoor' : undefined, floor: opt.floor }); console.log(`Added ${r.kind === 'outdoor' ? 'outdoor area' : 'room'} "${r.name}" at ${r.x},${r.y} ${r.w}x${r.h} (${r.id})`); break; }
    case 'rmroom': { const gone = await hb.removeRoom(rest[0]); console.log(`Removed ${gone.length} piece${gone.length > 1 ? 's' : ''} of ${gone[0].name}`); break; }
    case 'door': { const d = await hb.addDoor({ x: opt.x, y: opt.y, dir: opt.dir, w: opt.w, floor: opt.floor }); console.log(`Added ${d.w >= 80 ? 'wide opening' : 'door'} at ${d.x},${d.y} (${d.id})`); break; }
    case 'map': { const m = await hb.mapSummary(); for (const f of m.floors) { console.log(`${f.name} (${f.id})`); f.rooms.forEach(r => console.log(`  room ${r.name}  x${r.x} y${r.y} w${r.w} h${r.h}  color ${r.color}  ${r.id}`)); f.doors.forEach(d => console.log(`  door ${d.dir} at ${d.x},${d.y} w${d.w}  ${d.id}`)); f.assets.forEach(a => console.log(`  asset ${a.name} in ${a.room || '?'}${a.pinned ? ` (pinned ${a.pinned})` : ''}  ${a.id}`)); } console.log(`Unplaced: ${m.unplaced.join(', ') || 'none'}`); break; }
    case 'share': console.log(`Added ${await hb.share(rest[0])} to the household list`); break;
    case 'unshare': console.log(`Removed ${await hb.unshare(rest[0])} from the household list`); break;
    case 'shares': (await hb.shares()).forEach(s => console.log(`  ${s.email}  owner ${s.owner}`)); break;
    case 'dump': show(await hb.dump()); break;
    default: console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  }
} catch (e) { console.error(e.message); process.exit(1); }
