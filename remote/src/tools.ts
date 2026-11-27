// The MCP tools: same names, arguments and behaviour as tools/mcp.mjs, served statelessly at /mcp.
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler, getMcpAuthContext } from 'agents/mcp/server';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { firestore, ownerFor, type AppEnv, type Props } from './access';
import { COLLS, HomeBase, TITLE } from './lib';

const INSTRUCTIONS = 'Home Base is the household logbook (house, cars, yard, projects) at https://dhumphre.github.io/HomeBase/. Assets are things maintained; the schedule holds recurring tasks with next-due dates; log entries are work done; to-dos are open work. Refer to assets, tasks and to-dos by name. Dates are YYYY-MM-DD.';
const COLL = z.enum(COLLS);
const E = env as unknown as AppEnv;

/** The signed-in household member's logbook; re-checks the access list (cached a minute) so a removed account is cut off. */
async function logbook(): Promise<HomeBase> {
  const props = getMcpAuthContext()?.props as Partial<Props> | undefined;
  if (!props?.email) throw new Error('Not signed in.');
  const owner = await ownerFor(E, props.email);
  if (!owner) throw new Error(`${props.email} is not on the household list.`);
  return new HomeBase(firestore(E), owner, E.HOUSEHOLD_TZ || 'UTC');
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
function createServer() {
  const server = new McpServer({ name: 'homebase', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const tool = (name: string, description: string, shape: z.ZodRawShape, fn: (hb: HomeBase, args: any) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: z.object(shape) }, async (args: any) => {
      try { return text(await fn(await logbook(), args)); }
      catch (e) { return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true }; }
    });

  tool('status', 'What is overdue, due within 30 days, open to-dos, and scheduled tasks with no next-due date yet.', {}, hb => hb.status());
  tool('list', 'List documents in a collection, optionally filtered by exact field values (e.g. area=Car, asset=<id>, status=open).', { collection: COLL, filters: z.record(z.string(), z.string()).optional() }, (hb, a) => hb.list(a.collection, a.filters || {}));
  tool('get', 'One document by id, exact name, or unique part of its name.', { collection: COLL, query: z.string() }, (hb, a) => hb.find(a.collection, a.query));
  tool('add', 'Create a document with arbitrary fields (id, created, updated are filled in). Prefer the specific tools when one fits.', { collection: COLL, data: z.record(z.string(), z.any()) }, (hb, a) => hb.create(a.collection, a.data));
  tool('update', 'Merge fields into a document found by id or name.', { collection: COLL, query: z.string(), data: z.record(z.string(), z.any()) }, async (hb, a) => { const r = await hb.find(a.collection, a.query); await hb.merge(a.collection, r.id as string, a.data); return `Updated ${a.collection} ${r.id} (${r[TITLE[a.collection as keyof typeof TITLE]]})`; });
  tool('remove', 'Delete a document found by id or name. Confirm with the person first.', { collection: COLL, query: z.string() }, async (hb, a) => { const r = await hb.remove(a.collection, a.query); return `Deleted ${a.collection} ${r.id} (${r[TITLE[a.collection as keyof typeof TITLE]]})`; });
  tool('log_work', 'Record work that was done (a maintenance log entry), optionally against an asset.', { item: z.string(), asset: z.string().optional(), date: z.string().optional(), cost: z.number().optional(), mileage: z.number().optional(), doneBy: z.enum(['Me', 'Contractor', 'Dealer or shop']).optional(), notes: z.string().optional(), area: z.enum(['House', 'Car', 'Yard', 'Other']).optional() }, (hb, a) => hb.logWork(a));
  tool('complete_task', 'Mark a scheduled task done: logs it and rolls its next-due date forward from the completion date.', { task: z.string().describe('task name, part of it, or id; add the asset name to disambiguate, e.g. "oil Crosstrek" will not match, use the id from list if several'), date: z.string().optional(), cost: z.number().optional(), mileage: z.number().optional(), notes: z.string().optional(), doneBy: z.string().optional() }, (hb, a) => hb.complete(a.task, a));
  tool('add_todo', 'Add an open to-do, optionally tied to an asset.', { name: z.string(), asset: z.string().optional(), due: z.string().optional(), priority: z.enum(['high', 'medium', 'low']).optional(), notes: z.string().optional(), area: z.string().optional() }, (hb, a) => hb.addTodo(a));
  tool('add_asset', 'Add something to maintain (appliance, car, tool, supplies). Pass room to place it on the house map.', { name: z.string(), area: z.enum(['House', 'Car', 'Yard', 'Other']).optional(), type: z.string().optional(), make: z.string().optional(), serial: z.string().optional(), year: z.number().optional(), purchased: z.string().optional(), specs: z.string().optional(), contact: z.string().optional(), manual: z.string().optional(), notes: z.string().optional().describe('markdown'), room: z.string().optional() }, (hb, a) => hb.addAsset(a));
  tool('add_schedule', 'Add a recurring task, usually tied to an asset.', { task: z.string(), asset: z.string().optional(), every: z.number().optional(), unit: z.enum(['months', 'weeks', 'years', 'miles']).optional(), nextDue: z.string().optional(), lastDone: z.string().optional(), season: z.string().optional(), notes: z.string().optional(), area: z.string().optional() }, (hb, a) => hb.addSchedule(a));
  tool('place_on_map', 'Put an asset in a room on the house map.', { asset: z.string(), room: z.string() }, (hb, a) => hb.place(a.asset, a.room));
  tool('map', 'Floors, rooms, doors and placed assets of the house map.', {}, hb => hb.mapSummary());
  tool('household', 'Who can open this logbook (Google accounts on the access list); add or remove an email. invite gives a Google account a separate, empty logbook of its own (for someone managing a different house), set up the first time they sign in to the site.', { add: z.string().optional(), remove: z.string().optional(), invite: z.string().optional() }, async (hb, a) => { if (a.add) await hb.share(a.add); if (a.invite) await hb.invite(a.invite); if (a.remove) await hb.unshare(a.remove); return hb.shares(); });
  return server;
}

export const mcpHandler = createMcpHandler(createServer, { route: '/mcp' });
