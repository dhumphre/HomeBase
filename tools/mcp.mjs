#!/usr/bin/env node
// MCP server over the Home Base data, so any Claude session can read and update the household logbook.
// Register once:  claude mcp add --scope user homebase -- node C:\Git\HomeBase\tools\mcp.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as hb from './lib.mjs';

const server = new McpServer({ name: 'homebase', version: '1.0.0' }, { instructions: 'Home Base is the household logbook (house, cars, yard, projects) at https://dhumphre.github.io/HomeBase/. Assets are things maintained; the schedule holds recurring tasks with next-due dates; log entries are work done; to-dos are open work. Refer to assets, tasks and to-dos by name. Dates are YYYY-MM-DD.' });
const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const tool = (name, description, shape, fn) => server.registerTool(name, { description, inputSchema: shape }, async args => { try { return text(await fn(args)); } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; } });
const COLL = z.enum(hb.COLLS);

tool('status', 'What is overdue, due within 30 days, open to-dos, and scheduled tasks with no next-due date yet.', {}, () => hb.status());
tool('list', 'List documents in a collection, optionally filtered by exact field values (e.g. area=Car, asset=<id>, status=open).', { collection: COLL, filters: z.record(z.string()).optional() }, a => hb.list(a.collection, a.filters || {}));
tool('get', 'One document by id, exact name, or unique part of its name.', { collection: COLL, query: z.string() }, a => hb.find(a.collection, a.query));
tool('add', 'Create a document with arbitrary fields (id, created, updated are filled in). Prefer the specific tools when one fits.', { collection: COLL, data: z.record(z.any()) }, a => hb.create(a.collection, a.data));
tool('update', 'Merge fields into a document found by id or name.', { collection: COLL, query: z.string(), data: z.record(z.any()) }, async a => { const r = await hb.find(a.collection, a.query); await hb.merge(a.collection, r.id, a.data); return `Updated ${a.collection} ${r.id} (${r[hb.TITLE[a.collection]]})`; });
tool('remove', 'Delete a document found by id or name. Confirm with the person first.', { collection: COLL, query: z.string() }, async a => { const r = await hb.remove(a.collection, a.query); return `Deleted ${a.collection} ${r.id} (${r[hb.TITLE[a.collection]]})`; });
tool('log_work', 'Record work that was done (a maintenance log entry), optionally against an asset.', { item: z.string(), asset: z.string().optional(), date: z.string().optional(), cost: z.number().optional(), mileage: z.number().optional(), doneBy: z.enum(['Me', 'Contractor', 'Dealer or shop']).optional(), notes: z.string().optional(), area: z.enum(['House', 'Car', 'Yard', 'Other']).optional() }, a => hb.logWork(a));
tool('complete_task', 'Mark a scheduled task done: logs it and rolls its next-due date forward from the completion date.', { task: z.string().describe('task name, part of it, or id; add the asset name to disambiguate, e.g. "oil Crosstrek" will not match, use the id from list if several'), date: z.string().optional(), cost: z.number().optional(), mileage: z.number().optional(), notes: z.string().optional(), doneBy: z.string().optional() }, a => hb.complete(a.task, a));
tool('add_todo', 'Add an open to-do, optionally tied to an asset.', { name: z.string(), asset: z.string().optional(), due: z.string().optional(), priority: z.enum(['high', 'medium', 'low']).optional(), notes: z.string().optional(), area: z.string().optional() }, a => hb.addTodo(a));
tool('add_asset', 'Add something to maintain (appliance, car, tool, supplies). Pass room to place it on the house map.', { name: z.string(), area: z.enum(['House', 'Car', 'Yard', 'Other']).optional(), type: z.string().optional(), make: z.string().optional(), serial: z.string().optional(), year: z.number().optional(), purchased: z.string().optional(), specs: z.string().optional(), contact: z.string().optional(), manual: z.string().optional(), notes: z.string().optional().describe('markdown'), room: z.string().optional() }, a => hb.addAsset(a));
tool('add_schedule', 'Add a recurring task, usually tied to an asset.', { task: z.string(), asset: z.string().optional(), every: z.number().optional(), unit: z.enum(['months', 'weeks', 'years', 'miles']).optional(), nextDue: z.string().optional(), lastDone: z.string().optional(), season: z.string().optional(), notes: z.string().optional(), area: z.string().optional() }, a => hb.addSchedule(a));
tool('place_on_map', 'Put an asset in a room on the house map. facing turns a car or other long object: n toward the back of the map, s toward the viewer, e, w (outdoors a car faces n, the house, by default).', { asset: z.string(), room: z.string(), facing: z.enum(['n', 's', 'e', 'w']).optional() }, a => hb.place(a.asset, a.room, a.facing));
tool('add_room', 'Add a room piece to the house map (about 11 map units per foot; same-named pieces join into one room). kind "outdoor" makes paved ground with no walls, such as a driveway or patio.', { name: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number(), color: z.number().int().min(0).max(5).optional(), kind: z.enum(['room', 'outdoor']).optional(), floor: z.string().optional() }, a => hb.addRoom({ ...a, kind: a.kind === 'outdoor' ? 'outdoor' : undefined }));
tool('remove_room', 'Remove a room (every piece with that name) from the house map.', { room: z.string() }, a => hb.removeRoom(a.room));
tool('add_door', 'Add a door on a wall of the house map at a point (x,y) on that wall; dir "h" for a wall running left-right, "v" for up-down; width 36 for a door, 120 for a wide opening or garage door.', { x: z.number(), y: z.number(), dir: z.enum(['h', 'v']), w: z.number().optional(), floor: z.string().optional() }, a => hb.addDoor(a));
tool('remove_door', 'Remove a door from the house map by its id (see map).', { id: z.string() }, a => hb.removeDoor(a.id));
tool('map', 'Floors, rooms, doors and placed assets of the house map.', {}, () => hb.mapSummary());
tool('household', 'Who can open the logbook (Google accounts on the access list); add or remove an email.', { add: z.string().optional(), remove: z.string().optional() }, async a => { if (a.add) await hb.share(a.add); if (a.remove) await hb.unshare(a.remove); return hb.shares(); });

await server.connect(new StdioServerTransport());
