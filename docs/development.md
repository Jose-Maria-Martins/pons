# Developing and running your own Pons

For people who want to work on Pons or run their own copy. To just use Pons, see the [README](../README.md).

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
3. **Create a Turnstile widget** in the Cloudflare dashboard (Turnstile, Add widget, add your Worker's hostname). Put the **site key** in `wrangler.jsonc` under `vars.TURNSTILE_SITE_KEY` (it is public). Optionally set `vars.SOURCE_URL` to the public URL of your copy of the code; the `/privacy` page then links to it and to its issues.
4. **Set the secrets:**
   ```bash
   npx wrangler secret put TURNSTILE_SECRET   # the widget's secret key
   npx wrangler secret put HASH_KEY           # a long random string, e.g. from: openssl rand -hex 32
   ```
   Keep `HASH_KEY` stable: changing it makes every user look like a new user and invalidates the rate-limit keys.
5. **Deploy:** `npm run deploy`.
6. **Sign in once yourself:** in claude.ai go to Settings, Connectors, Add custom connector, and enter `https://<your-worker>/mcp`. Sign in to Garmin on the page that opens.

### Usage statistics

`PONS_EVENTS` writes to the Analytics Engine dataset `pons_events` (created on first deploy). [`scripts/stats.sql`](../scripts/stats.sql) holds queries for users, calls per tool, calls per platform and per client app, and sign-in outcomes. The SQL API takes one query at a time, with an API token that has the Account Analytics Read permission:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $API_TOKEN" \
  --data "SELECT blob2 AS tool, SUM(_sample_interval) AS calls FROM pons_events WHERE blob1 = 'tool' GROUP BY tool ORDER BY calls DESC"
```

### Known limits

- **Login rate limit:** Cloudflare's rate-limit binding only allows a 10 or 60 second period, so the limit is 5 tries per minute per IP and per email, not per 10 minutes.
- **Platform guess:** the device kind comes from the User-Agent. Requests that Claude makes from Anthropic's servers may all show up as `other`.
- **"Today"** is the date in the time zone of your Garmin account, read once when you sign in (grants made earlier get it on their next refresh; until then it is the UTC date).
- **Some tools are newer and less proven:** `day_timeline`, `personal_records` and `planned_workouts` read Garmin endpoints whose response shapes were written from the garminconnect library's documentation, not checked against a real account yet.
- Garmin has no public API for this. Pons uses the same endpoints as Garmin's mobile app, which can change without notice.

## Layout

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry: OAuth provider, routes `/mcp`, `/authorize`, `/privacy` and the icon (`/icon.png`, `/favicon.ico`) |
| `src/login/authorize.ts` | `/authorize` flow: Turnstile, rate limits, Garmin login, finish the grant |
| `src/login/page.ts` | The sign-in and privacy pages and their security headers |
| `src/login/garmin.ts` | Garmin sign-in: SSO login, 2FA code, token exchange, profile, token refresh |
| `src/login/mfa.ts` | The half-finished 2FA sign-in: encrypted state in KV and its cookie |
| `src/analytics.ts` | Usage events for Analytics Engine, platform guess, request context |
| `src/crypto.ts` | HMAC helper |
| `src/mcp/server.ts` | MCP server and its tools |
| `src/garmin/api.ts` | Garmin data calls with the bearer token |
| `src/garmin/shape.ts` | Shrinks Garmin responses into compact rows; date handling |
