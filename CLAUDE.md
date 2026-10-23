# Pons

A remote MCP server on Cloudflare Workers (TypeScript) that lets Claude read a user's Garmin Connect data. Users add it as a custom connector in claude.ai and sign in to Garmin once, on Pons's own sign-in page.

## Layout

- `src/index.ts`: Worker entry. `OAuthProvider` (from `@cloudflare/workers-oauth-provider`) serves `/authorize`, `/token`, `/register`; `/mcp` goes to the MCP handler
- `src/login/authorize.ts`: `/authorize` flow (Turnstile, rate limits, Garmin login, `completeAuthorization`)
- `src/login/page.ts`: sign-in and `/privacy` page HTML and security headers
- `src/login/garmin.ts`: Garmin mobile SSO login, 2FA code, DI token exchange, profile, DI token refresh
- `src/login/mfa.ts`: encrypted 2FA state in KV (AES-GCM, HKDF from handle + `HASH_KEY`) and its `__Host-` cookie
- `src/analytics.ts`: Analytics Engine events (`PONS_EVENTS`), platform from User-Agent, per-request context (`AsyncLocalStorage`)
- `src/crypto.ts`: `hmacHex`
- `src/mcp/server.ts`: MCP server (`McpServer` from `@modelcontextprotocol/server`), instructions, tools (every tool has a `title` and `READ_ONLY` annotations)
- `src/garmin/api.ts`: Garmin data calls (`connectapi.garmin.com`, Bearer token)
- `src/garmin/shape.ts`: `first`, `pick`, `slim`, date helpers, row shaping
- `test/`: Vitest in the Workers runtime; `fetch` is always mocked

## Commands

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run dev        # wrangler dev, needs .dev.vars (copy .dev.vars.example)
```

## Rules

- **Never commit personal data.** No real Garmin responses, tokens, emails or `.dev.vars`. Fixtures are invented.
- **Tools are read-only toward Garmin.** Every Garmin tool sets `readOnlyHint: true`. The only exception is `disconnect` (`destructiveHint: true`), which revokes the user's own Pons grants and never touches Garmin. Anything that writes to a Garmin account needs an explicit discussion first.
- **Analytics hold names and timings only.** `src/analytics.ts` is the one place that writes events: no health values, emails, display names or tokens. Keep `PRIVACY.md`, the `/privacy` page and `scripts/stats.sql` in step with it.
- **Errors Claude should see are `isError` results with plain text.** Register tool bodies through `call(name, body)` in `server.ts` (rate limit, `runTool()`, analytics); extend `describeError()` rather than catching inside tools.
- **Keep responses small.** Pass Garmin responses through `slim()` or shape them in `shape.ts`. Prefer range endpoints over looping per day.
- **The password is never stored or logged.** Logs hold outcome names and status codes only.
- **Dependencies are pinned** to exact versions, and `package-lock.json` is committed. Prefer official Cloudflare, MCP, zod, TypeScript, Vitest and ESLint packages. Review a new dependency before adding it.
- **CI actions are pinned to commit SHAs**, and Dependabot proposes updates. Review them like any dependency bump.
- **No deploys from CI** and no secrets in code. Secrets go through `wrangler secret`.
- Tests never contact Garmin. Mock `fetch` (see `test/helpers.ts`).

## Gotchas

- Garmin field names vary between endpoints and over time; use `first()` / `pick()` with fallbacks.
- The Garmin API is unofficial (the mobile app's endpoints) and can change.
- `.npmrc` sets `legacy-peer-deps=true` to avoid an npm crash on the peer-dependency cycle.
- Cloudflare's rate-limit binding only allows a period of 10 or 60 seconds.
- The OAuth library needs the canonical resource URL, so `index.ts` builds one provider per request origin.

## Workflow

- Work on a branch and open a PR before merging into `main`.
- Keep PRs small and focused; describe what changed and how it was tested.
