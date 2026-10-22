# Pons

Talk to your Garmin data from Claude. Pons is a remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers: you add it to Claude as a custom connector, sign in to Garmin once, and Claude can then read your sleep, heart rate, stress and Body Battery.

Pons is read-only. No tool writes to your Garmin account.

> Status: milestone 1. Three tools, no 2FA accounts yet, not deployed anywhere by this repository.

## What it does

| Tool | What it answers |
|---|---|
| `connection_status` | Is Garmin connected, and when did the watch last sync? |
| `daily_overview` | One day: steps, heart rate, stress, Body Battery, last night's sleep and HRV, training readiness. |
| `sleep_history` | Nightly sleep summaries for a date range (default 30 days, max 366). |

## How it works

```
Claude --OAuth + MCP--> Pons (Cloudflare Worker) --> Garmin Connect
                          |
                          |- /authorize   sign-in page: Turnstile, rate limits, Garmin login
                          |- /token, /register, /.well-known/*   OAuth (workers-oauth-provider)
                          '- /mcp         stateless MCP server (agents + MCP SDK), three tools
```

- **Your password goes to Garmin and nowhere else.** The Worker forwards it once, then drops it. It is never stored or logged.
- **What is stored:** Garmin's login token and a refresh token, inside the OAuth grant in Workers KV. The OAuth library encrypts them at rest with a key only the holder of Claude's access token can unwrap.
- **Who you are:** an HMAC of your Garmin id, keyed with a secret only the operator holds. Emails are never stored; a keyed hash of the email is used only as a rate-limit key.
- The sign-in page checks you are a person ([Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)) and limits attempts per IP and per email before it contacts Garmin.

See [SECURITY.md](SECURITY.md) for the threat model.

## Local development

Needs Node 22.12 or newer.

```bash
npm ci
cp .dev.vars.example .dev.vars   # Cloudflare's always-pass Turnstile test keys
npm run dev                      # http://localhost:8787
```

```bash
npm run typecheck
npm run lint
npm test
```

Tests mock `fetch`; they never contact Garmin and use made-up data only.

Check the server by hand:

```bash
curl http://localhost:8787/.well-known/oauth-authorization-server   # OAuth metadata
curl -i -X POST http://localhost:8787/mcp                           # 401 without a token
```

`.npmrc` sets `legacy-peer-deps=true`. npm 10 crashes on this dependency tree's optional peer cycle (vite, vitest and the `agents` package) without it. The runtime code only imports packages that are installed explicitly.

## Deploy

Nothing here deploys by itself; CI only runs typecheck, lint and tests. To run your own copy:

1. **Log in:** `npx wrangler login`.
2. **Create the KV namespace** and put its id in `wrangler.jsonc` (replace the zeros under `kv_namespaces`):
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```
3. **Create a Turnstile widget** in the Cloudflare dashboard (Turnstile, Add widget, add your Worker's hostname). Put the **site key** in `wrangler.jsonc` under `vars.TURNSTILE_SITE_KEY` (it is public).
4. **Set the secrets:**
   ```bash
   npx wrangler secret put TURNSTILE_SECRET   # the widget's secret key
   npx wrangler secret put HASH_KEY           # a long random string, e.g. from: openssl rand -hex 32
   ```
   Keep `HASH_KEY` stable: changing it makes every user look like a new user and invalidates the rate-limit keys.
5. **Deploy:** `npm run deploy`.
6. **Sign in once yourself:** in claude.ai go to Settings, Connectors, Add custom connector, and enter `https://<your-worker>/mcp`. Sign in to Garmin on the page that opens.

### Known limits

- **Login rate limit:** Cloudflare's rate-limit binding only allows a 10 or 60 second period, so the limit is 5 tries per minute per IP and per email, not per 10 minutes.
- **Garmin login expiry:** Pons does not refresh Garmin's token yet. When it expires, disconnect and reconnect the connector.
- **"Today"** is the UTC date.
- Accounts with two-step verification (2FA) can't connect yet.
- Garmin has no public API for this. Pons uses the same endpoints as Garmin's mobile app, which can change without notice.

## Layout

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry: OAuth provider, routes `/mcp` and `/authorize` |
| `src/login/authorize.ts` | `/authorize` flow: Turnstile, rate limits, Garmin login, finish the grant |
| `src/login/page.ts` | The sign-in page HTML and its security headers |
| `src/login/garmin.ts` | Garmin sign-in: SSO login, token exchange, profile |
| `src/mcp/server.ts` | MCP server and the three tools |
| `src/garmin/api.ts` | Garmin data calls with the bearer token |
| `src/garmin/shape.ts` | Shrinks Garmin responses into compact rows; date handling |
