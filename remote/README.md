# Home Base remote MCP server

A Cloudflare Worker that serves the Home Base logbook over MCP (Streamable HTTP) so Claude can use it from the phone app, claude.ai and Claude Code on any machine. It is the OAuth server for those clients, signs people in with Google, and admits only Google accounts on the Firestore household list (`access/{email}`). The tools are the same as the local server in `../tools` (`status`, `list`, `get`, `add`, `update`, `remove`, `log_work`, `complete_task`, `add_todo`, `add_asset`, `add_schedule`, `place_on_map`, `map`, `household`); `src/lib.ts` is a port of `../tools/lib.mjs`, so keep the two in step.

- Worker: `https://homebase-mcp.dhumphre.workers.dev`
- MCP endpoint: `https://homebase-mcp.dhumphre.workers.dev/mcp`
- Google callback: `https://homebase-mcp.dhumphre.workers.dev/callback`

## How it is wired

| Piece | Where |
| --- | --- |
| OAuth server for MCP clients (`/authorize`, `/token`, `/register`, discovery) | `@cloudflare/workers-oauth-provider`, state in the `OAUTH_KV` namespace |
| Consent page and Google sign-in | `src/index.ts`, `src/pages.ts` |
| Household check | `src/access.ts`: the lowercased email must have an `access/{email}` document; its `owner` field is the uid whose data is served. Re-checked on every tool call (cached a minute) and on every token refresh. |
| Firestore | `src/firestore.ts`: the REST API with an access token minted from the service-account key (RS256 JWT signed with WebCrypto). No firebase-admin. |
| Tools | `src/tools.ts` (`createMcpHandler` from `agents`, MCP SDK v2) |

Plain vars live in `wrangler.jsonc` (`MCP_RESOURCE`, `FIREBASE_PROJECT`, `HOUSEHOLD_TZ`, the time zone used for "today").

## Secrets

Set once with `npx wrangler secret put <NAME>` from this folder (it prompts for the value; nothing is stored in the repo):

| Secret | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth client ID (Web application) from the Google Cloud console, project `trailhead-almanac`, with the callback URL above as an authorized redirect URI |
| `GOOGLE_CLIENT_SECRET` | Its client secret |
| `FIREBASE_SERVICE_ACCOUNT` | The service-account JSON, piped in: `Get-Content $HOME\.homebase\service-account.json -Raw \| npx wrangler secret put FIREBASE_SERVICE_ACCOUNT` |

## Deploy

```powershell
cd C:\Git\HomeBase\remote
npm install
npx wrangler login        # once per machine, in an interactive terminal
npx wrangler types        # regenerates worker-configuration.d.ts for the type check (npm run check)
npx wrangler deploy
```

`npx wrangler tail` streams live logs. The `OAUTH_KV` namespace id in `wrangler.jsonc` was created with `npx wrangler kv namespace create OAUTH_KV`.

## Connect a client

- **claude.ai / phone app**: Settings → Connectors → Add custom connector, name `Home Base`, URL `https://homebase-mcp.dhumphre.workers.dev/mcp`. Approve the consent page, sign in with a household Google account.
- **Claude Code**:

```powershell
claude mcp add --transport http homebase-remote https://homebase-mcp.dhumphre.workers.dev/mcp
```

then `/mcp` inside Claude Code to authenticate.

## Who may sign in

Anyone whose email has an `access/{email}` document. Add or remove people with the `household` tool, or locally with `node tools/hb.mjs share <email>` / `unshare <email>`. Everyone else sees "Not on the household list".

### A separate logbook for another house

`household` with `invite: <email>` (or `node tools/hb.mjs invite <email>`) writes `access/{email}` as `{ invite: true, invitedBy }` with no owner. The first time that person signs in to the site, it claims the invite: the rules let it set `owner` to its own uid and drop `invite`, and nothing else, so it gets an empty logbook under its own `users/{uid}` and can never point itself at anyone else's. After that they can connect Claude with the same connector URL and `share` their own household members. Only the original household (the first owner on the list) can invite from the connector. Each household's `household` tool lists and removes only its own entries.

The local tools default to the first owner on the list; set `HB_EMAIL=<their email>` to run `hb.mjs` against an invited household's logbook.
