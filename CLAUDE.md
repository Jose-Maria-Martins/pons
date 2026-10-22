# Pons

A remote MCP server on Cloudflare Workers (TypeScript) that lets Claude read a user's Garmin Connect data. Users add it as a custom connector in claude.ai and sign in to Garmin once, on Pons's own sign-in page.

## Layout

- `src/index.ts`: Worker entry. `OAuthProvider` (from `@cloudflare/workers-oauth-provider`) serves `/authorize`, `/token`, `/register`; `/mcp` goes to the MCP handler
- `src/login/authorize.ts`: `/authorize` flow (Turnstile, rate limits, Garmin login, `completeAuthorization`)
- `src/login/page.ts`: sign-in page HTML and security headers
- `src/login/garmin.ts`: Garmin mobile SSO login, DI token exchange, profile
- `src/mcp/server.ts`: MCP server (`McpServer` from `@modelcontextprotocol/server`), instructions, tools
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
- **Tools are read-only.** Every tool sets `readOnlyHint: true` and only reads from Garmin. Anything that writes to a Garmin account needs an explicit discussion first.
- **Errors Claude should see are `isError` results with plain text.** Wrap tool bodies in `runTool()`; extend `describeError()` rather than catching inside tools.
- **Keep responses small.** Pass Garmin responses through `slim()` or shape them in `shape.ts`. Prefer range endpoints over looping per day.
- **The password is never stored or logged.** Logs hold outcome names and status codes only.
- **Dependencies are pinned** to exact versions, and `package-lock.json` is committed. Prefer official Cloudflare, MCP, zod, TypeScript, Vitest and ESLint packages. Review a new dependency before adding it.
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
