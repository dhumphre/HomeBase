// Who may use the server: a Google account whose lowercased email has an access/{email} document naming the owner uid.
import { Firestore, type ServiceAccount } from './firestore';

export interface AppEnv {
  MCP_RESOURCE: string;
  FIREBASE_PROJECT: string;
  HOUSEHOLD_TZ: string;
  OAUTH_KV: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  FIREBASE_SERVICE_ACCOUNT: string;
}
/** What completeAuthorization() stores for a session; handlers get it back as props. */
export interface Props extends Record<string, unknown> { email: string; name: string; owner: string }

let db: { key: string; fs: Firestore } | undefined;
export function firestore(env: AppEnv): Firestore {
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('The FIREBASE_SERVICE_ACCOUNT secret is not set.');
  if (!db || db.key !== env.FIREBASE_SERVICE_ACCOUNT) db = { key: env.FIREBASE_SERVICE_ACCOUNT, fs: new Firestore(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) as ServiceAccount, env.FIREBASE_PROJECT) };
  return db.fs;
}

const cache = new Map<string, { owner: string | null; exp: number }>();
/** The owner uid this email may open, or null when it is not on the list. Cached briefly so each tool call stays one Firestore round trip. */
export async function ownerFor(env: AppEnv, email: string, fresh = false): Promise<string | null> {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const hit = cache.get(e);
  if (!fresh && hit && hit.exp > Date.now()) return hit.owner;
  const doc = await firestore(env).get(`access/${e}`);
  const owner = doc && typeof doc.owner === 'string' && doc.owner ? doc.owner : null;
  cache.set(e, { owner, exp: Date.now() + 60_000 });
  return owner;
}
