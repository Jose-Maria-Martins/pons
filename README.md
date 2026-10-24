<p align="center"><img src="assets/icon.png" width="88" alt=""></p>

<h1 align="center">Pons</h1>

<p align="center">
  <b>Ask your AI about your Garmin data.</b><br>
  Sleep, recovery, training and workouts, in plain language. Read-only, nothing to install.
</p>

<p align="center">
  <a href="https://github.com/Jose-Maria-Martins/pons/actions/workflows/ci.yml"><img src="https://github.com/Jose-Maria-Martins/pons/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="MIT licence"></a>
</p>

<p align="center"><img src="docs/hero.gif" width="720" alt="Someone asks how they slept this week; Pons fetches their sleep history and the AI answers with a weekly chart and a short summary. Made-up data."></p>

## What you can ask

- *"How did I sleep this week compared with last month?"*
- *"Am I recovered enough for a hard run today?"*
- *"How did my marathon go, lap by lap?"*
- *"When did my Body Battery drop today, and why?"*
- *"What's on my training plan this week?"*
- *"Has my resting heart rate changed since I started training?"*

Your AI picks the data it needs from Garmin Connect and answers in plain language, compared with your own history.

## Why Pons

- **Nothing to install.** Paste one address into your AI and sign in to Garmin. It then works on your computer and your phone.
- **Read-only.** Pons can look at your Garmin data. It can't change anything in your account.
- **Your password goes only to Garmin.** Pons keeps an encrypted login token, never your password. See [what Pons collects](PRIVACY.md).
- **Built for questions, not endpoints.** 14 focused tools that return just what's needed, instead of one tool per Garmin call. Your AI picks the right data more often, and chats stay light.

<!-- Suggested "why I built it" line, in your words: "I wanted to ask about my own training without exporting spreadsheets, so I built Pons. It's a personal project: free, open source and not affiliated with Garmin." -->

## Get started

Pons's address:

```
https://pons.jose-maria-martins.workers.dev/mcp
```

You need a Garmin Connect account and an AI app that can add a custom connector (the open standard behind this is [MCP](https://modelcontextprotocol.io)). Pons is tested with Claude and ChatGPT. Gemini uses the same standard but hasn't been tested with Pons yet.

### Claude

Every plan works; the Free plan allows one custom connector. Add it once on the web or desktop app and it also works in the phone app.

1. Open [this link](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Pons&connectorUrl=https%3A%2F%2Fpons.jose-maria-martins.workers.dev%2Fmcp) in your browser. It opens Claude's "Add custom connector" window with Pons filled in. (Or go to **Customize**, **Connectors**, choose **Add custom connector** and paste the address.)
2. Leave the advanced settings as they are and click **Add**, then **Connect**.
3. Sign in with your Garmin email and password on the Pons page. If Garmin sends you a code, enter it there.
4. Back in Claude, ask a question.

### ChatGPT

Works on the free plan too. Add it on chatgpt.com in a browser.

1. Open [ChatGPT's Plugins page](https://chatgpt.com/plugins), click **Add** and choose **Add custom MCP server**.
2. For the icon, save [the Pons icon](https://pons.jose-maria-martins.workers.dev/icon.png) and choose it under **Icon**. ChatGPT can't change the icon later.
3. Name it Pons, add a description such as "Reads my Garmin data", paste the address under **Server URL** and choose **OAuth** for authentication.
4. Tick **I understand and want to continue**, choose **Create as a plugin**, then install it from your plugins.
5. Sign in to Garmin on the page that opens. In a chat, type **@** and pick Pons.

### Gemini

Google allows custom apps for personal Google accounts, 18 or older, in the US, in English, with Keep Activity on.

1. On a computer, open gemini.google.com, then **Settings**, **Connected Apps**, **Add a custom app**.
2. Paste the address. Pons registers itself, so leave the advanced fields empty.
3. Click **Next** and sign in to Garmin. Pons then also works in the Gemini phone app.

### Other apps

Any app that supports remote MCP servers with OAuth can use the same address. For example, in Claude Code:

```bash
claude mcp add --transport http pons https://pons.jose-maria-martins.workers.dev/mcp
```

### Disconnecting

Ask your AI to "disconnect Pons". That deletes the stored Garmin login. Then remove the connector in your AI's settings.

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

---

## For developers and recruiters

<!-- Next round: architecture diagram, security highlights, built with, limits, and self-hosting moved to docs/. The sections below are unchanged for now. -->

## How it works

```
Claude --OAuth + MCP--> Pons (Cloudflare Worker) --> Garmin Connect
                          |
                          |- /authorize   sign-in page: Turnstile, rate limits, Garmin login, 2FA code
                          |- /privacy     what Pons collects and stores
                          |- /token, /register, /.well-known/*   OAuth (workers-oauth-provider)
                          '- /mcp         stateless MCP server (agents + MCP SDK), 14 tools
```

- **Your password goes to Garmin and nowhere else.** The Worker forwards it once, then drops it. It is never stored or logged.
- **What is stored:** Garmin's login token and a refresh token, plus your Garmin time zone (for example `Europe/London`), inside the OAuth grant in Workers KV. The OAuth library encrypts them at rest with a key only the holder of Claude's access token can unwrap.
- **Who you are:** an HMAC of your Garmin id, keyed with a secret only the operator holds. Emails are never stored; a keyed hash of the email is used only as a rate-limit key.
- **2FA:** if your Garmin account asks for a verification code, a second page collects it. Between the two pages the half-finished sign-in waits in KV for 10 minutes, AES-GCM encrypted with a key derived from a random handle that only your browser holds (in a `__Host-` cookie) and the operator's `HASH_KEY`. You get 3 tries; the entry is deleted on success, on the third wrong code and on expiry.
- **Refresh:** when Claude refreshes its Pons token, Pons also refreshes the Garmin token if it has under 3 hours left, so the connection keeps working. If Garmin refuses the refresh, the grant ends and Claude asks you to reconnect; if Garmin is only busy, the grant is kept and Claude tries again later.
- The sign-in page checks you are a person ([Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)) and limits attempts per IP and per email before it contacts Garmin.

- **Limits and counts:** each user gets 60 tool calls per minute. Pons counts tool calls, connections and sign-in outcomes in Cloudflare Analytics Engine, with no health values, emails, names or tokens.

See [SECURITY.md](SECURITY.md) for the threat model and [PRIVACY.md](PRIVACY.md) for exactly what is collected and stored.

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

`PONS_EVENTS` writes to the Analytics Engine dataset `pons_events` (created on first deploy). [`scripts/stats.sql`](scripts/stats.sql) holds queries for users, calls per tool, calls per platform and per client app, and sign-in outcomes. The SQL API takes one query at a time, with an API token that has the Account Analytics Read permission:

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
