#!/usr/bin/env node
// Command-line access to the Home Base data, for Claude Code or a terminal. Same data layer as the MCP server (mcp.mjs).
// Needs a service-account key kept OUTSIDE the repo: %USERPROFILE%\.homebase\service-account.json (or HB_SERVICE_ACCOUNT=<path>).
//
//   node tools/hb.mjs status                         what is overdue, due soon (by date or by miles), open; each car's odometer and next task
//   node tools/hb.mjs ls <coll> [key=value ...]      assets | log | schedule | todos | projects | pages  (cars show their odometer)
//   node tools/hb.mjs get <coll> <id or name> [--asset <name>]   (--asset: whose task, when both cars have one of that name; schedule only)
//   node tools/hb.mjs add <coll> '<json>'            new document; '@file.json' reads it from a file
//   node tools/hb.mjs set <coll> <id or name> '<json>' [--asset <name>]   merge fields into a document (e.g. set schedule "Oil and filter change" '{"everyMiles":6000,"lastMiles":58200}' --asset Legacy)
//   node tools/hb.mjs rm <coll> <id or name> [--asset <name>]
//   node tools/hb.mjs log "<what>" [--asset <name>] [--date YYYY-MM-DD] [--cost 120] [--mileage 48210] [--by "Dealer or shop"] [--notes "..."]
//                                                    a mileage on a car's entry also moves its odometer forward
//   node tools/hb.mjs done "<task or id>" [--asset <name>] [--date YYYY-MM-DD] [--mileage n] [--cost 90] [--by "Dealer or shop"] [--notes "..."]
//                                                    logs it and rolls the next-due date; --asset picks whose task when both cars have one of that name
//                                                    ("Oil and filter change" --asset Legacy); --mileage is the odometer at the time and sets the task's last-done miles
//   node tools/hb.mjs odometer "<car>" <miles> [--date YYYY-MM-DD]   record a car's odometer reading (today unless --date); drives the by-miles estimates
//   node tools/hb.mjs todo "<name>" [--asset <name>] [--due YYYY-MM-DD] [--priority high] [--notes "..."]
//   node tools/hb.mjs asset "<name>" [--area House] [--type "Water heater"] [--make Rheem] [--year 2019] [--specs "..."] [--room Garage]
//   node tools/hb.mjs schedule "<task>" --asset <name> [--every 6 --unit months] [--miles 6000] [--last-miles 58200] [--next YYYY-MM-DD] [--last YYYY-MM-DD] [--notes "..."]
//                                                    --every/--unit is the time interval, --miles the mileage interval (either or both; a car task is due at whichever comes first);
//                                                    --last-miles is the odometer when it was last done, needed before a by-miles estimate can be made
//   node tools/hb.mjs place <asset> <room> [--facing n|s|e|w]   put a component in a room on the map (facing: which way a car points; outdoors n = toward the house)
//   node tools/hb.mjs room "<name>" --x 820 --y 350 --w 200 --h 250 [--color 0-5] [--outdoor]   add a room piece (about 11 units per foot)
//   node tools/hb.mjs rmroom <name or id>            remove a room (every piece of that name); components assigned to it become unplaced, doors left on no wall go
//   node tools/hb.mjs door --x 880 --y 340 --dir h [--w 36|120]   a door (w 120 = wide opening / garage door) on a wall at that point
//   node tools/hb.mjs dock <asset> <parent> | undock <asset>   a part installed in another asset rides with it on the map (surge protector in the panel)
//   node tools/hb.mjs turn <asset> n|s|e|w           rotate something already on the map (its front faces that way)
//   node tools/hb.mjs rmdoor <id>                    remove a door
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
const mi = n => `${hb.fmtMiles(n)} mi`;
// "6 months / 6,000 mi": the time interval, the mileage interval, or both (unit 'miles' is the legacy spelling of a mileage interval).
const every = r => { const em = r.everyMiles ?? (r.unit === 'miles' ? r.every : null); return [r.every != null && r.unit !== 'miles' ? `${r.every} ${r.unit}` : null, em ? mi(em) : null].filter(Boolean).join(' / ') || '—'; };
const line = (c, r) => { const t = r[hb.TITLE[c]]; const extra = c === 'schedule' ? ` next ${r.nextDue || '—'} every ${every(r)}${r.lastMiles != null ? ` last at ${mi(r.lastMiles)}` : ''}` : c === 'log' ? ` ${r.date}${r.mileage != null ? ` @ ${mi(r.mileage)}` : ''}` : c === 'todos' ? ` [${r.status || 'open'}]${r.due ? ' due ' + r.due : ''}` : c === 'assets' ? ` ${[r.area, r.type, r.make].filter(Boolean).join(' · ')}${hb.isCar(r) ? `  odometer ${r.odometer != null ? `${mi(r.odometer)} (${r.odometerOn})` : 'not recorded'}` : ''}` : ''; return `${r.id}  ${t}${extra}${r.asset ? `  asset:${r.asset}` : ''}`; };
const warn = r => { if (r.warning) console.warn(`Warning: ${r.warning}`); return r; };
const lookup = (c, q) => c === 'schedule' ? hb.findTask(q, opt.asset) : hb.find(c, q); // schedule names repeat across the cars; --asset picks whose

try {
  switch (cmd) {
    case 'status': {
      const s = await hb.status(); const row = x => `  ${x.label}  ${x.task}${x.asset ? ` (${x.asset})` : ''}  ${x.id}`; const brief = x => `  ${x.task}${x.asset ? ` (${x.asset})` : ''}  ${x.id}`;
      console.log('Overdue:'); s.overdue.forEach(x => console.log(row(x))); console.log('Due within 30 days:'); s.dueSoon.forEach(x => console.log(row(x)));
      console.log('Open to-dos:'); s.openTodos.forEach(x => console.log(`  [${x.status}] ${x.name}${x.asset ? ` (${x.asset})` : ''}${x.due ? ' due ' + x.due : ''}  ${x.id}`));
      console.log('Cars:'); s.cars.forEach(c => console.log(`  ${c.name}: ${c.odometer != null ? `${mi(c.odometer)}, read ${c.staleDays === 0 ? 'today' : `${c.staleDays} day${c.staleDays === 1 ? '' : 's'} ago`} (${c.readOn}), ~${Math.round(c.perDay)} mi/day${c.estimatedRate ? ' assumed' : ''}` : 'no odometer reading'}; next up: ${c.nextUp ? `${c.nextUp.task}, ${c.nextUp.label}` : 'nothing with a date'}`));
      if (s.needsOdometer.length) { console.log('Needs an odometer reading (hb odometer "<car>" <miles>):'); s.needsOdometer.forEach(x => console.log(brief(x))); }
      if (s.needsBaseline.length) { console.log('Set last done (hb set schedule <id> \'{"lastMiles": n}\' or hb done ... --mileage n):'); s.needsBaseline.forEach(x => console.log(brief(x))); }
      console.log(`No next-due date yet: ${s.unscheduled.length}`); break;
    }
    case 'ls': { const c = hb.checkColl(rest[0]); const f = Object.fromEntries(rest.slice(1).map(x => x.split('='))); const rows = await hb.list(c, f); rows.forEach(r => console.log(line(c, r))); console.log(`${rows.length} ${c}`); break; }
    case 'get': show(await lookup(hb.checkColl(rest[0]), rest[1])); break;
    case 'add': { const d = await hb.create(hb.checkColl(rest[0]), json(rest[1])); console.log(`Added ${rest[0]} ${d.id}`); break; }
    case 'set': { const c = hb.checkColl(rest[0]); const r = await lookup(c, rest[1]); await hb.merge(c, r.id, json(rest[2])); console.log(`Updated ${c} ${r.id}`); break; }
    case 'rm': { const c = hb.checkColl(rest[0]); const r = await hb.remove(c, await lookup(c, rest[1])); console.log(`Deleted ${c} ${r.id} (${r[hb.TITLE[c]]})`); break; }
    case 'log': { const d = warn(await hb.logWork({ item: rest[0], asset: opt.asset, date: opt.date, area: opt.area, cost: opt.cost, doneBy: opt.by, mileage: opt.mileage, notes: opt.notes })); console.log(`Logged "${d.item}" on ${d.date} (${d.id})${d.odometer ? `; odometer ${mi(d.odometer.miles)} as of ${d.odometer.on}` : ''}`); break; }
    case 'done': { const r = warn(await hb.complete(rest[0], { asset: opt.asset, date: opt.date, cost: opt.cost, mileage: opt.mileage, notes: opt.notes, doneBy: opt.by })); const next = [r.nextDue ? `due ${r.nextDue}` : null, r.nextAtMiles != null ? `at ${mi(r.nextAtMiles)}${r.milesLeft != null ? ` (${mi(r.milesLeft)} to go)` : ''}` : null].filter(Boolean).join(' or '); console.log(`Logged "${r.task}"${r.asset ? ` for ${r.asset}` : ''} on ${r.done}; next ${next || 'due: none (no interval)'}${r.odometer ? `; odometer ${mi(r.odometer.miles)} as of ${r.odometer.on}` : ''}`); break; }
    case 'odometer': { const r = warn(await hb.setOdometer(rest[0], rest[1], opt.date)); console.log(`${r.asset}: odometer ${mi(r.odometer.miles)} as of ${r.odometer.on}${r.previous ? ` (was ${mi(r.previous.miles)} on ${r.previous.on})` : ' (first reading)'}`); break; }
    case 'todo': { const d = await hb.addTodo({ name: rest[0], asset: opt.asset, due: opt.due, priority: opt.priority, status: opt.status, area: opt.area, notes: opt.notes }); console.log(`Added to-do "${d.name}" (${d.id})`); break; }
    case 'asset': { const d = await hb.addAsset({ name: rest[0], ...opt }); console.log(`Added asset "${d.name}" (${d.id})${d.placedIn ? ` in ${d.placedIn}` : opt.room ? ` (no room named "${opt.room}", left unplaced)` : ''}`); break; }
    case 'schedule': { const d = await hb.addSchedule({ task: rest[0], asset: opt.asset, every: opt.every, unit: opt.unit, everyMiles: opt.miles, lastMiles: opt['last-miles'], nextDue: opt.next, lastDone: opt.last, season: opt.season, area: opt.area, notes: opt.notes }); console.log(`Scheduled "${d.task}" every ${every(d)}${d.nextDue ? `, next ${d.nextDue}` : ''}${d.lastMiles != null ? `, last done at ${mi(d.lastMiles)}` : ''} (${d.id})`); break; }
    case 'place': { const r = await hb.place(rest[0], rest[1], opt.facing); console.log(`${r.asset} placed in ${r.room}${r.facing ? ` facing ${r.facing}` : ''}`); break; }
    case 'room': { const r = await hb.addRoom({ name: rest[0], x: opt.x, y: opt.y, w: opt.w, h: opt.h, color: opt.color, kind: opt.outdoor ? 'outdoor' : undefined, floor: opt.floor }); console.log(`Added ${r.kind === 'outdoor' ? 'outdoor area' : 'room'} "${r.name}" at ${r.x},${r.y} ${r.w}x${r.h} (${r.id})`); break; }
    case 'rmroom': { const r = await hb.removeRoom(rest[0]); console.log(`Removed ${r.removed.length} piece${r.removed.length > 1 ? 's' : ''} of ${r.removed[0].name}${r.unplaced.length ? `; now unplaced: ${r.unplaced.join(', ')}` : ''}${r.doorsRemoved ? `; ${r.doorsRemoved} door${r.doorsRemoved > 1 ? 's' : ''} left on no wall removed` : ''}`); break; }
    case 'door': { const d = await hb.addDoor({ x: opt.x, y: opt.y, dir: opt.dir, w: opt.w, floor: opt.floor }); console.log(`Added ${d.w >= 80 ? 'wide opening' : 'door'} at ${d.x},${d.y} (${d.id})`); break; }
    case 'rmdoor': { const d = await hb.removeDoor(rest[0]); console.log(`Removed door at ${d.x},${d.y}`); break; }
    case 'dock': { const r = await hb.dock(rest[0], rest[1]); console.log(`${r.asset} is now installed in ${r.in}`); break; }
    case 'undock': { const r = await hb.dock(rest[0], null); console.log(`${r.asset} is on its own again`); break; }
    case 'turn': { const r = await hb.turn(rest[0], rest[1]); console.log(`${r.asset} now faces ${r.facing}`); break; }
    case 'map': { const m = await hb.mapSummary(); for (const f of m.floors) { console.log(`${f.name} (${f.id})`); f.rooms.forEach(r => console.log(`  room ${r.name}  x${r.x} y${r.y} w${r.w} h${r.h}  color ${r.color}  ${r.id}`)); f.doors.forEach(d => console.log(`  door ${d.dir} at ${d.x},${d.y} w${d.w}  ${d.id}`)); f.assets.forEach(a => console.log(`  asset ${a.name} in ${a.room || '?'}${a.pinned ? ` (pinned ${a.pinned})` : ''}${a.parts && a.parts.length ? ` [contains ${a.parts.join(', ')}]` : ''}  ${a.id}`)); } console.log(`Unplaced: ${m.unplaced.join(', ') || 'none'}`); break; }
    case 'share': console.log(`Added ${await hb.share(rest[0])} to the household list`); break;
    case 'unshare': console.log(`Removed ${await hb.unshare(rest[0])} from the household list`); break;
    case 'shares': (await hb.shares()).forEach(s => console.log(`  ${s.email}  owner ${s.owner}`)); break;
    case 'dump': show(await hb.dump()); break;
    default: { const src = readFileSync(new URL(import.meta.url), 'utf8').split(/\r?\n/); const usage = []; for (const l of src.slice(src[0].startsWith('#!') ? 1 : 0)) { if (!l.startsWith('//')) break; usage.push(l.slice(3)); } console.log(usage.join('\n')); } // the comment block at the top only, so comments inside the code stay out of the usage text
  }
} catch (e) { console.error(e.message); process.exit(1); }
