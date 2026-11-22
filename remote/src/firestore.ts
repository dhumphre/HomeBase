// Firestore over its REST API, authenticated with a service account (no firebase-admin in a Worker).
// A short-lived OAuth access token is minted from the key with an RS256 JWT signed by WebCrypto and cached per isolate.

export interface ServiceAccount { project_id: string; client_email: string; private_key: string }
export type Doc = Record<string, unknown>;

const enc = new TextEncoder();
const b64url = (data: ArrayBuffer | Uint8Array | string): string => {
  const bytes = typeof data === 'string' ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const pemToDer = (pem: string): ArrayBuffer => {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

const tokens = new Map<string, { token: string; exp: number }>();
export async function accessToken(sa: ServiceAccount): Promise<string> {
  const hit = tokens.get(sa.client_email);
  if (hit && hit.exp - 60_000 > Date.now()) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`));
  const assertion = `${header}.${claims}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const body = await res.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`Google token request failed: ${body.error || res.status} ${body.error_description || ''}`.trim());
  tokens.set(sa.client_email, { token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 });
  return body.access_token;
}

// Firestore's typed values <-> plain JSON, matching what the Admin SDK writes for the same data.
type FsValue = { nullValue?: null; booleanValue?: boolean; integerValue?: string; doubleValue?: number; stringValue?: string; timestampValue?: string; referenceValue?: string; bytesValue?: string; geoPointValue?: { latitude: number; longitude: number }; arrayValue?: { values?: FsValue[] }; mapValue?: { fields?: Record<string, FsValue> } };
const isPlain = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
export function encodeValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v as Doc) } };
  throw new Error(`Cannot store a ${typeof v} in Firestore`);
}
export function encodeFields(o: Doc): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = encodeValue(v);
  return out;
}
export function decodeValue(v: FsValue): unknown {
  if (!v || 'nullValue' in v) return null;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.referenceValue !== undefined) return v.referenceValue;
  if (v.bytesValue !== undefined) return v.bytesValue;
  if (v.geoPointValue !== undefined) return v.geoPointValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(decodeValue);
  if (v.mapValue !== undefined) return decodeFields(v.mapValue.fields || {});
  return null;
}
export const decodeFields = (f: Record<string, FsValue>): Doc => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, decodeValue(v)]));

// Field paths for an updateMask: nested plain objects merge field by field, like set(..., { merge: true }).
const quote = (seg: string) => /^[A-Za-z_][A-Za-z_0-9]*$/.test(seg) ? seg : '`' + seg.replace(/[\\`]/g, '\\$&') + '`';
export function maskPaths(o: Doc, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    const p = prefix + quote(k);
    if (isPlain(v) && Object.keys(v).length) out.push(...maskPaths(v, p + '.')); else out.push(p);
  }
  return out;
}

export class Firestore {
  private base: string;
  constructor(private sa: ServiceAccount, project = sa.project_id) {
    this.base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  }
  private url(path: string) { return `${this.base}/${path.split('/').map(encodeURIComponent).join('/')}`; }
  private async call(method: string, url: string, body?: unknown): Promise<any> {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${await accessToken(this.sa)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 404) return null;
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Firestore ${method} ${res.status}: ${data?.error?.message || res.statusText}`);
    return data;
  }
  /** One document's fields, or null when it does not exist. */
  async get(path: string): Promise<Doc | null> { const d = await this.call('GET', this.url(path)); return d ? decodeFields(d.fields || {}) : null; }
  /** Every document in a collection. */
  async list(path: string): Promise<Doc[]> {
    const out: Doc[] = []; let token: string | undefined;
    do {
      const d = await this.call('GET', `${this.url(path)}?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
      for (const doc of d?.documents || []) out.push(decodeFields(doc.fields || {}));
      token = d?.nextPageToken;
    } while (token);
    return out;
  }
  /** Replace the whole document (create or overwrite). */
  async set(path: string, data: Doc): Promise<void> { await this.call('PATCH', this.url(path), { fields: encodeFields(data) }); }
  /** Merge fields into a document, creating it if needed. */
  async merge(path: string, data: Doc): Promise<void> {
    const paths = maskPaths(data); if (!paths.length) return;
    await this.call('PATCH', `${this.url(path)}?${paths.map(p => `updateMask.fieldPaths=${encodeURIComponent(p)}`).join('&')}`, { fields: encodeFields(data) });
  }
  async delete(path: string): Promise<void> { await this.call('DELETE', this.url(path)); }
}
