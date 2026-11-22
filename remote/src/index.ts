// Home Base remote MCP server: a Cloudflare Worker that is the OAuth authorization server for MCP clients
// (claude.ai connectors, Claude Code), signs people in with Google, and admits only the household (Firestore access list).
import { OAuthProvider, OAuthError, AuthorizationError, CimdFetchError, authorizationErrorRedirect, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { env } from 'cloudflare:workers';
import { ownerFor, type AppEnv, type Props } from './access';
import { consentPage, errorPage, homePage, notHouseholdPage } from './pages';
import { mcpHandler } from './tools';

type AuthEnv = AppEnv & { OAUTH_PROVIDER: OAuthHelpers };
const E = env as unknown as AppEnv;
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const callbackUrl = (env: AppEnv) => new URL('/callback', env.MCP_RESOURCE).toString();
const html = (body: string, headers = new Headers(), status = 200) => { headers.set('Content-Type', 'text/html; charset=utf-8'); return new Response(body, { status, headers }); };
const redirect = (headers: Headers, to: string) => { headers.set('Location', to); return new Response(null, { status: 302, headers }); };
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (s: string) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

// GET /authorize: the MCP client sent the person here. Show who is asking, then (on Allow) hand them to Google.
async function authorize(req: Request, env: AuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (req.method === 'GET') {
    const request = await oauth.parseAuthRequest(req);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    return html(consentPage(details, consent.handle), consent.headers);
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const form = await req.formData();
  const handle = String(form.get('handle') || '');
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(req, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(req, handle);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
  const u = new URL(GOOGLE_AUTH);
  u.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: callbackUrl(env), response_type: 'code', scope: 'openid email profile', state, code_challenge: await sha256(verifier), code_challenge_method: 'S256', access_type: 'online', prompt: 'select_account' }).toString();
  return redirect(headers, u.toString());
}

// GET /callback: back from Google. Exchange the code, read the email, admit only the household.
async function callback(req: Request, env: AuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  if (url.searchParams.get('error') || !code) return redirect(headers, authorizationErrorRedirect(original, 'access_denied'));

  const tok = await fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: callbackUrl(env), grant_type: 'authorization_code', code_verifier: data.verifier }) });
  const token = await tok.json() as { access_token?: string; error?: string; error_description?: string };
  if (!tok.ok || !token.access_token) return errorPage(`Google did not accept the sign-in (${token.error || tok.status}). ${token.error_description || ''}`, 502);
  const who = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${token.access_token}` } });
  const user = await who.json() as { sub?: string; email?: string; email_verified?: boolean; name?: string };
  const email = String(user.email || '').trim().toLowerCase();
  if (!who.ok || !user.sub || !email) return errorPage('Google did not say who signed in.', 502);
  if (user.email_verified === false) return html(notHouseholdPage(email), headers, 403);

  const owner = await ownerFor(env, email, true);
  if (!owner) return html(notHouseholdPage(email), headers, 403);
  const props: Props = { email, name: user.name || email, owner };
  const { redirectTo } = await oauth.completeAuthorization({ request: original, userId: user.sub, metadata: { label: props.name }, scope: original.scope, props });
  return redirect(headers, redirectTo);
}

const defaultHandler = {
  async fetch(req: Request, env: AppEnv): Promise<Response> {
    const auth = env as AuthEnv;
    const path = new URL(req.url).pathname;
    try {
      if (path === '/authorize') return await authorize(req, auth);
      if (path === '/callback') return await callback(req, auth);
      if (path === '/' || path === '') return html(homePage(env.MCP_RESOURCE));
      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError) return errorPage(error.description);
      if (error instanceof CimdFetchError) return errorPage('This app could not be verified.');
      throw error;
    }
  },
};

export default new OAuthProvider<AppEnv>({
  apiRoute: '/mcp',
  apiHandler: { fetch: (req: Request, env: AppEnv, ctx: ExecutionContext) => mcpHandler(req, env, ctx) },
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: E.MCP_RESOURCE },
  // On refresh, re-check the household list: an account that was removed loses its grant instead of refreshing forever.
  tokenExchangeCallback: async ({ grantType, props, env }) => {
    if (grantType !== 'refresh_token') return;
    const p = props as Props;
    let owner: string | null;
    try { owner = await ownerFor(env, p.email, true); }
    catch { throw new OAuthError('temporarily_unavailable', { description: 'The household list could not be checked right now', statusCode: 503 }); }
    if (!owner) throw new OAuthError('invalid_grant', { description: 'This Google account is no longer on the household list' });
    return { newProps: { ...p, owner } };
  },
});
