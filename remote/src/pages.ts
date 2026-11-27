// The few HTML pages people see: the landing page, the consent page, and the sign-in outcomes.
import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

export const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{color-scheme:light dark;--bg:#f6f4ef;--card:#fff;--ink:#1f2a1f;--mute:#5d6b5d;--line:#dcd8cf;--accent:#2f6b3a;--accent-ink:#fff;--warn:#8a5a00;--warn-bg:#fff4dc}
@media(prefers-color-scheme:dark){:root{--bg:#161b16;--card:#1f261f;--ink:#e8ecdf;--mute:#9aa894;--line:#303a30;--accent:#6fbf7a;--accent-ink:#0f170f;--warn:#f0c674;--warn-bg:#3a2f12}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:1.35rem;margin:0 0 6px}p{margin:10px 0;color:var(--mute)}strong{color:var(--ink)}code{font:0.9em ui-monospace,Menlo,Consolas,monospace;background:var(--bg);padding:2px 6px;border-radius:6px;word-break:break-all}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:14px;color:var(--mute);font-size:.9rem}.brand span{display:inline-grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--accent);color:var(--accent-ink);font-weight:700}
.warn{background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:10px 12px}
.row{display:flex;gap:10px;margin-top:20px}button,a.btn{flex:1;appearance:none;border:1px solid var(--line);border-radius:10px;padding:11px 14px;font:inherit;font-weight:600;cursor:pointer;background:var(--card);color:var(--ink);text-align:center;text-decoration:none}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
`;
export const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${CSS}</style></head>
<body><main><div class="brand"><span>HB</span>Home Base</div>${body}</main></body></html>`;

export const homePage = (resource: string) => page('Home Base MCP server', `
<h1>Home Base MCP server</h1>
<p>Claude talks to the household logbook through this server. Add it as a connector with this URL:</p>
<p><code>${escape(resource)}</code></p>
<p>Only Google accounts on the household list can sign in.</p>
<div class="row"><a class="btn" href="https://dhumphre.github.io/HomeBase/">Open Home Base</a></div>`);

export const consentPage = (d: ConsentDescription, handle: string) => page('Allow access to Home Base', `
<h1>Allow <strong>${escape(d.clientName)}</strong> to use Home Base?</h1>
<p>${d.clientDomain ? `Published by <strong>${escape(d.clientDomain)}</strong>.` : 'This app registered itself; its name is not verified.'} Access will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn">This sends access to an app on this computer. Continue only if you just started connecting from it.</p>' : ''}
<p>Next you will sign in with Google. The account must be on the household list.</p>
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<div class="row"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Allow and sign in</button></div></form>`);

export const notHouseholdPage = (email: string) => page('Not on the household list', `
<h1>Not on the household list</h1>
<p><strong>${escape(email)}</strong> cannot open the Home Base logbook.</p>
<p>Sign in with the Google account the household uses, or ask a member to add this one.</p>
<p>Invited to a logbook of your own? Sign in once at <a href="https://dhumphre.github.io/HomeBase/">Home Base</a> to set it up, then connect again.</p>`);

export const errorPage = (message: string, status = 400) => new Response(page('Something went wrong', `<h1>Something went wrong</h1><p>${escape(message)}</p><p>Go back to the app and start connecting again.</p>`), { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
