# How Pons works, and running your own

For people who want to know how Pons works, work on it, or run their own copy. To just use Pons, see the [README](../README.md).

## How it works

```
Your AI --OAuth + MCP--> Pons (Cloudflare Worker) --> Garmin Connect
                           |
                           |- /authorize   sign-in page: Turnstile, rate limits, Garmin login, 2FA code
                           |- /privacy     what Pons collects and stores
                           |- /token, /register, /.well-known/*   OAuth (workers-oauth-provider)
                           '- /mcp         stateless MCP server (agents + MCP SDK), 14 tools
```

- **Your password goes to Garmin and nowhere else.** The Worker forwards it once, then drops it. It is never stored or logged.
- **What is stored:** Garmin's login token and a refresh token, plus your Garmin time zone (for example `Europe/London`), inside the OAuth grant in Workers KV. The OAuth library encrypts them at rest with a key only the holder of your AI's access token can unwrap.
- **Who you are:** an HMAC of your Garmin id, keyed with a secret only the operator holds. Emails are never stored; a keyed hash of the email is used only as a rate-limit key.
- **2FA:** if your Garmin account asks for a verification code, a second page collects it. Between the two pages the half-finished sign-in waits in KV for 10 minutes, AES-GCM encrypted with a key derived from a random handle that only your browser holds (in a `__Host-` cookie) and the operator's `HASH_KEY`. You get 3 tries; the entry is deleted on success, on the third wrong code and on expiry.
- **Refresh:** when your AI refreshes its Pons token, Pons also refreshes the Garmin token if it has under 3 hours left, so the connection keeps working. If Garmin refuses the refresh, the grant ends and your AI asks you to reconnect; if Garmin is only busy, the grant is kept and it tries again later.
- **Abuse protection:** the sign-in page checks you are a person ([Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)) and limits attempts per IP and per email before it contacts Garmin. Each user gets 60 tool calls per minute.
- **Usage counts:** Pons counts tool calls, connections and sign-in outcomes in Cloudflare Analytics Engine, with no health values, emails, names or tokens.

See [SECURITY.md](../SECURITY.md) for the threat model and [PRIVACY.md](../PRIVACY.md) for exactly what is collected and stored.

**Built with:** TypeScript on Cloudflare Workers, Workers KV and Analytics Engine, `@cloudflare/workers-oauth-provider` for OAuth 2.1, the MCP TypeScript SDK with Cloudflare's `agents`, Cloudflare Turnstile, Vitest and GitHub Actions.

## Tools

| Tool | What it answers |
|---|---|
| `connection_status` | Is Garmin connected, which watch, and when did it last sync? |
| `daily_overview` | One day: steps, heart rate, stress, Body Battery, last night's sleep and HRV, training readiness. |
| `sleep_history` | Nightly sleep summaries for a date range (default 30 days, max 366). |
| `daily_trends` | One row per day: steps, calories, resting HR, stress, Body Battery, intensity minutes, sleep time (default 30 days, max 366). |
| `sleep_night_detail` | One night in detail: stages, score factors, overnight HRV, SpO2, respiration. |
| `hrv_history` | Nightly HRV with the 7-day average, baseline range and status (default 30 days, max 180). |
| `activities` | Workouts in a range with distance, duration, pace or speed, heart rate, training effect and load (default 30 days, max 366, at most 200 workouts), optionally by type, or just the N most recent with `limit`. |
| `activity_detail` | One workout with laps, time in heart rate and power zones, weather, and the sets of a strength workout. |
| `training_status` | Training status and load, readiness, VO2 max, race predictions, endurance and hill score, fitness age, lactate threshold, running power, cycling FTP, heart rate zones. |
| `body_composition` | Weight and body composition (default 90 days, max 366). This is also the weight history tool: Garmin serves both from the same endpoint. |
| `day_timeline` | One day in 15-minute steps (local time): heart rate, stress, Body Battery, steps. |
| `personal_records` | Personal records (fastest 5 km, longest run, and so on). |
| `planned_workouts` | Workouts on the Garmin calendar, including training plans (default next 14 days, max 90). |
| `disconnect` | Deletes your Pons connections and the stored Garmin login. Your AI only calls it when you ask. |

What you get depends on your watch: a watch without running power, for example, has no power zones.

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
