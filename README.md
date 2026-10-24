<p align="center"><img src="assets/icon.png" width="88" alt=""></p>

<h1 align="center">Pons</h1>

<!-- Slogan: pending your pick. -->
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

> *"Make me a 16-week plan for the London Marathon, based on my current fitness."*

- *"How did I sleep this week compared with last month?"*
- *"Am I recovered enough for a hard run today?"*
- *"How did my marathon go, lap by lap?"*
- *"When did my Body Battery drop today, and why?"*
- *"Has my resting heart rate changed since I started training?"*

Your AI picks the data it needs from Garmin Connect and answers in plain language, compared with your own history.

## Why Pons

- **Nothing to install.** Paste one address into your AI and sign in to Garmin. It then works on your computer and your phone.
- **Read-only.** Pons can look at your Garmin data. It can't change anything in your account.
- **Your password goes only to Garmin.** Pons keeps an encrypted login token, never your password. See [what Pons collects](PRIVACY.md).
- **Built for questions, not endpoints.** 14 focused tools that return just what's needed, instead of one tool per Garmin call. Your AI picks the right data more often, and chats stay light.

## Why I built it

I bought my Garmin before running the Lisbon Marathon. It's on my wrist 24 hours a day, so it knows more about me than almost anything I own: every run, every night of sleep, every heartbeat.

The first week, the Garmin Connect app amazed me. By the second, I was curious: what more could I learn about myself if an AI could read all of it?

Pons is my answer. It's a personal project: free, open source and not affiliated with Garmin.

## Get started

Pons's address:

```
https://pons.jose-maria-martins.workers.dev/mcp
```

You need a Garmin Connect account and an AI app that can add a custom connector (the open standard behind this is [MCP](https://modelcontextprotocol.io)). Pons is tested with Claude and ChatGPT. Gemini uses the same standard but hasn't been tested with Pons yet.

<details open>
<summary><b>Claude</b>: one link, about a minute</summary>

Every plan works; the Free plan allows one custom connector. Add it once on the web or desktop app and it also works in the phone app.

1. Open [this link](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Pons&connectorUrl=https%3A%2F%2Fpons.jose-maria-martins.workers.dev%2Fmcp) in your browser. It opens Claude's "Add custom connector" window with Pons filled in. (Or go to **Customize**, **Connectors**, choose **Add custom connector** and paste the address.)
2. Leave the advanced settings as they are and click **Add**, then **Connect**.
3. Sign in with your Garmin email and password on the Pons page. If Garmin sends you a code, enter it there.
4. Back in Claude, ask a question.

</details>

<details>
<summary><b>ChatGPT</b>: a short form, once</summary>

Works on the free plan too. ChatGPT has no ready-made link, so it takes a few fields, once, on chatgpt.com in a browser.

1. Save [the Pons icon](https://pons.jose-maria-martins.workers.dev/icon.png) to your computer. ChatGPT can't change the icon later.
2. Open [ChatGPT's Plugins page](https://chatgpt.com/plugins), click **Add** and choose **Add custom MCP server**.

   <img src="docs/chatgpt-add.png" width="560" alt="ChatGPT's Plugins page with the Add menu open, showing Add custom MCP server.">

3. Fill in the form:
   - **Icon:** the file you saved
   - **Name:** Pons
   - **Description:** Reads my Garmin data
   - **Server URL:** the address above
   - **Authentication:** OAuth

   <img src="docs/chatgpt-form.png" width="560" alt="The Add custom MCP server form filled in for Pons, with OAuth chosen.">

4. Tick **I understand and want to continue**, choose **Create as a plugin**, then install it from your plugins and sign in to Garmin on the page that opens.
5. In a chat, type **@** and pick Pons.

</details>

<details>
<summary><b>Gemini</b>: not tested yet</summary>

Google allows custom apps for personal Google accounts, 18 or older, in the US, in English, with Keep Activity on.

1. On a computer, open gemini.google.com, then **Settings**, **Connected Apps**, **Add a custom app**.
2. Paste the address. Pons registers itself, so leave the advanced fields empty.
3. Click **Next** and sign in to Garmin. Pons then also works in the Gemini phone app.

</details>

<details>
<summary><b>Other apps</b></summary>

Any app that supports remote MCP servers with OAuth can use the same address. For example, in Claude Code:

```bash
claude mcp add --transport http pons https://pons.jose-maria-martins.workers.dev/mcp
```

</details>

**Disconnecting:** ask your AI to "disconnect Pons". That deletes the stored Garmin login. Then remove the connector in your AI's settings.

## What Pons can read

<details>
<summary>14 read-only tools. Your AI picks them for you; open this to see the list.</summary>

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

</details>

---

## How it's built

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

See [SECURITY.md](SECURITY.md) for the threat model and [PRIVACY.md](PRIVACY.md) for exactly what is collected and stored.

**Built with:** TypeScript on Cloudflare Workers, Workers KV and Analytics Engine, `@cloudflare/workers-oauth-provider` for OAuth 2.1, the MCP TypeScript SDK with Cloudflare's `agents`, Cloudflare Turnstile, Vitest and GitHub Actions.

**Working on Pons or running your own copy?** See [docs/development.md](docs/development.md): local setup, tests, deploying, usage statistics, known limits and the code layout.
