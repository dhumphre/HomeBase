// The Home Base data logic, ported from tools/lib.mjs (keep the two in step) onto the Firestore REST layer.
// Every document carries id (20 hex chars), created and updated (ms epoch).
import { Firestore, type Doc } from './firestore';

export const COLLS = ['assets', 'log', 'schedule', 'todos', 'projects', 'pages'] as const;
export type Coll = (typeof COLLS)[number];
export const TITLE: Record<Coll, string> = { assets: 'name', log: 'item', schedule: 'task', todos: 'name', projects: 'name', pages: 'title' };

export const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Today's date in the household's time zone (the Worker itself runs in UTC). */
export const today = (tz: string): string => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
export const addInterval = (s: string, n: number, unit: string): string => { const d = new Date(`${s}T12:00:00`); if (unit === 'weeks') d.setDate(d.getDate() + 7 * n); else if (unit === 'years') d.setFullYear(d.getFullYear() + n); else d.setMonth(d.getMonth() + n); return ymd(d); };
export const daysUntil = (s: unknown, tz: string): number | null => s ? Math.round((new Date(`${s}T12:00:00`).getTime() - new Date(`${today(tz)}T12:00:00`).getTime()) / 864e5) : null;
export const slugify = (s: unknown) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'page';
const num = (v: unknown): number | null => v == null || v === '' ? null : Number(v);
const clean = (o: Doc): Doc => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const str = (v: unknown) => String(v ?? '');

export function checkColl(c: string): Coll { if (!(COLLS as readonly string[]).includes(c)) throw new Error(`Collection must be one of ${COLLS.join(', ')}`); return c as Coll; }

export interface Room { id?: string; name?: string; floor?: string; x: number; y: number; w: number; h: number; color?: number }
export interface Spot { floor?: string; x: number; y: number }
export function roomSpot(rooms: Room[], name: string, slot = 0): Spot | null {
  const rs = rooms.filter(r => str(r.name).toLowerCase() === String(name).toLowerCase()); if (!rs.length) return null;
  const r = rs.sort((a, b) => b.w * b.h - a.w * a.h)[0]; const snap = (v: number) => Math.round(v / 10) * 10;
  const fx = [0.5, 0.3, 0.7, 0.5, 0.3, 0.7][slot % 6], fy = [0.5, 0.35, 0.35, 0.75, 0.7, 0.7][slot % 6];
  return { floor: r.floor, x: snap(r.x + r.w * fx), y: snap(r.y + r.h * fy) };
}

/** One household's logbook: the subcollections of users/{owner}. */
export class HomeBase {
  constructor(private db: Firestore, readonly owner: string, private tz: string) {}
  private coll(c: Coll) { return `users/${this.owner}/${c}`; }
  today() { return today(this.tz); }

  async all(c: string): Promise<Doc[]> { return this.db.list(this.coll(checkColl(c))); }
  async create(c: string, data: Doc): Promise<Doc> {
    const id = uid(); const now = Date.now(); const doc: Doc = { ...clean(data), id, created: now, updated: now };
    if (c === 'pages' && !doc.slug) doc.slug = slugify(doc.title);
    await this.db.set(`${this.coll(checkColl(c))}/${id}`, doc); return doc;
  }
  async merge(c: string, id: string, data: Doc): Promise<void> { await this.db.merge(`${this.coll(checkColl(c))}/${id}`, { ...clean(data), updated: Date.now() }); }
  async remove(c: string, q: string): Promise<Doc> { const r = await this.find(c, q); await this.db.delete(`${this.coll(checkColl(c))}/${r.id}`); return r; }

  // One document by id, exact title, or a unique case-insensitive substring of the title.
  async find(c: string, q: string): Promise<Doc> {
    const rows = await this.all(c); const t = TITLE[checkColl(c)]; const needle = String(q).toLowerCase();
    const byId = rows.find(r => r.id === q); if (byId) return byId;
    const exact = rows.filter(r => str(r[t]).toLowerCase() === needle); if (exact.length === 1) return exact[0];
    const part = rows.filter(r => str(r[t]).toLowerCase().includes(needle));
    if (part.length === 1) return part[0];
    if (!part.length) throw new Error(`No ${c.replace(/s$/, '')} matches "${q}".`);
    throw new Error(`"${q}" matches several ${c}: ${part.map(r => `${r[t]} (${r.id})`).join('; ')}`);
  }
  findAsset(q: unknown): Promise<Doc | null> { return q ? this.find('assets', String(q)) : Promise.resolve(null); }

  async list(c: string, filters: Record<string, unknown> = {}): Promise<Doc[]> {
    let rows = await this.all(c); const t = TITLE[checkColl(c)];
    for (const [k, v] of Object.entries(filters)) if (v != null && v !== '') rows = rows.filter(r => str(r[k]).toLowerCase() === String(v).toLowerCase());
    return rows.sort((a, b) => str(a[t]).localeCompare(str(b[t])));
  }

  async status() {
    const [sched, todos, assets] = await Promise.all([this.all('schedule'), this.all('todos'), this.all('assets')]);
    const name = (id: unknown) => (assets.find(a => a.id === id) || {}).name || null;
    const due = sched.filter(s => s.nextDue).map(s => ({ id: s.id, task: s.task, asset: name(s.asset), nextDue: s.nextDue, days: daysUntil(s.nextDue, this.tz) as number })).sort((a, b) => a.days - b.days);
    return {
      overdue: due.filter(s => s.days < 0),
      dueSoon: due.filter(s => s.days >= 0 && s.days <= 30),
      openTodos: todos.filter(t => t.status !== 'done').map(t => ({ id: t.id, name: t.name, status: t.status || 'open', asset: name(t.asset), due: t.due || null, priority: t.priority || null })),
      unscheduled: sched.filter(s => !s.nextDue).map(s => ({ id: s.id, task: s.task, asset: name(s.asset), every: s.every, unit: s.unit })),
    };
  }

  async logWork({ item, asset, date, area, cost, doneBy, mileage, notes }: Doc) {
    const a = await this.findAsset(asset);
    return this.create('log', { item, date: date || this.today(), area: area || (a ? a.area : null) || null, asset: a ? a.id : null, cost: num(cost), doneBy: doneBy || 'Me', mileage: num(mileage), notes: notes || null });
  }

  // Mirrors the site's Done button: a log entry, then the next-due date rolls forward from the completion date.
  async complete(q: string, { date, cost, mileage, notes, doneBy }: Doc = {}) {
    const s = await this.find('schedule', q); const t = (date as string) || this.today();
    const a = s.asset ? (await this.all('assets')).find(x => x.id === s.asset) : null;
    await this.create('log', { item: s.task, date: t, area: s.area || null, asset: s.asset || null, doneBy: doneBy || 'Me', cost: num(cost), mileage: num(mileage), notes: notes || null });
    const next: Doc = { lastDone: t }; if (s.unit !== 'miles' && s.every) next.nextDue = addInterval(t, Number(s.every), (s.unit as string) || 'months');
    await this.merge('schedule', s.id as string, next);
    return { task: s.task, asset: a ? a.name : null, done: t, nextDue: next.nextDue || null };
  }

  async addTodo({ name, asset, due, priority, status, area, notes }: Doc) {
    const a = await this.findAsset(asset);
    return this.create('todos', { name, status: status || 'open', priority: priority || '', due: due || null, area: area || (a ? a.area : null) || null, asset: a ? a.id : null, notes: notes || null });
  }

  async addSchedule({ task, asset, every, unit, nextDue, lastDone, season, area, notes }: Doc) {
    const a = await this.findAsset(asset);
    return this.create('schedule', { task, area: area || (a ? a.area : null) || 'House', asset: a ? a.id : null, every: num(every) ?? 12, unit: unit || 'months', nextDue: nextDue || null, lastDone: lastDone || null, season: season || null, notes: notes || null });
  }

  async layout(): Promise<Doc> { return (await this.db.get(`users/${this.owner}/map/layout`)) || { floors: [{ id: 'main', name: 'Main floor' }], rooms: [], doors: [] }; }
  async addAsset({ name, area, type, make, serial, year, purchased, specs, contact, manual, notes, room }: Doc) {
    let map: Spot | null = null, placedIn: unknown = null;
    if (room) { const m = await this.layout(); const here = (await this.all('assets')).filter(a => a.map).length; map = roomSpot((m.rooms as Room[]) || [], String(room), here); placedIn = map ? room : null; }
    const doc = await this.create('assets', { name, area: area || 'House', type: type || null, make: make || null, serial: serial || null, year: num(year), purchased: purchased || null, specs: specs || null, contact: contact || null, manual: manual || null, notes: notes || '', map });
    return { ...doc, placedIn };
  }
  async place(assetQ: string, room: string) {
    const a = await this.find('assets', assetQ); const m = await this.layout();
    const taken = (await this.all('assets')).filter(x => x.map && x.id !== a.id).map(x => { const s = x.map as Spot; return `${s.x},${s.y}`; });
    let spot: Spot | null = null; for (let i = 0; i < 6 && !spot; i++) { const s = roomSpot((m.rooms as Room[]) || [], room, i); if (!s) break; if (!taken.includes(`${s.x},${s.y}`)) spot = s; }
    if (!spot) throw new Error(`No room named "${room}" on the map.`);
    await this.merge('assets', a.id as string, { map: spot }); return { asset: a.name, room, ...spot };
  }
  async mapSummary() {
    const m = await this.layout(); const assets = await this.all('assets'); const floors = (m.floors as Doc[]) || [{ id: 'main', name: 'Main floor' }];
    const rooms = (m.rooms as Room[]) || [], doors = (m.doors as Doc[]) || [];
    return {
      floors: floors.map(f => ({ ...f, rooms: rooms.filter(r => r.floor === f.id).map(r => ({ id: r.id, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h, color: r.color ?? 0 })), doors: doors.filter(d => d.floor === f.id), assets: assets.filter(a => a.map && (a.map as Spot).floor === f.id).map(a => ({ id: a.id, name: a.name, x: (a.map as Spot).x, y: (a.map as Spot).y })) })),
      unplaced: assets.filter(a => !a.map).map(a => a.name),
    };
  }

  // Household access list: access/{email} -> { owner } lets that Google account open the owner's data (the rules check it).
  async share(email: string) { const e = String(email).trim().toLowerCase(); await this.db.set(`access/${e}`, { owner: this.owner, email: e, added: Date.now() }); return e; }
  async unshare(email: string) { const e = String(email).trim().toLowerCase(); await this.db.delete(`access/${e}`); return e; }
  async shares() { return this.db.list('access'); }
}
