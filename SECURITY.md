# Security

Pons asks people to type their Garmin password into a page it serves. That deserves a written threat model. Each section below names a risk, what Pons does about it, and what is left over.

## Reporting a vulnerability

Open a private security advisory on this repository (Security tab, "Report a vulnerability"). Please do not file a public issue for a vulnerability. Expect an answer within a few days; this is a one-person project.

## Password in transit

Risk: someone reads or keeps the Garmin password.

- The password travels from the browser to Pons over HTTPS and from Pons to `sso.garmin.com` over HTTPS. It is held in memory for one request.
- It is never stored, logged or echoed back. Logs hold outcome names and status codes only. The same goes for the 2FA code.
- The sign-in page sends a strict Content-Security-Policy (scripts only from a per-request nonce and Cloudflare Turnstile), `frame-ancestors 'none'`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- Left over: a Worker that runs modified code could capture passwords. See "Operator access".

## Token theft

Risk: someone obtains the Garmin token or a Pons access token.

- Garmin's token is stored in the OAuth grant in Workers KV, encrypted by `@cloudflare/workers-oauth-provider` with a key that only the holder of the access token can unwrap.
- Claude's access tokens last one hour; refresh tokens last 90 days.
- The Garmin token can read health data. It is limited to what Garmin allows that mobile client.
- The `disconnect` tool revokes every grant of the user, which deletes the stored token. Claude can call it whenever the user asks.
- Left over: a stolen access token works until it expires (one hour) or the grant is revoked.

## Abuse of the login page and the tools

Risk: bots guess passwords through Pons, or one user gets Pons blocked by Garmin.

- Cloudflare Turnstile is verified server-side before any Garmin request.
- Sign-in attempts are rate-limited per IP and, separately, per email (an HMAC, never the email itself), before any Garmin request. The 2FA step has its own limit and allows 3 wrong codes.
- The consent handle is single-use and bound to the browser by a cookie, which blocks login CSRF.
- Tool calls are limited to 60 per minute per user (keyed by an HMAC of the Garmin id). Beyond that, the tool answers with a plain error and does not contact Garmin.
- Left over: Cloudflare's rate-limit binding only allows 10 or 60 second periods, so the sign-in limit is per minute, not per 10 minutes.

## Operator access

Risk: the person running the Worker misuses what it can see.

- The operator can see Worker logs (outcome names only), KV keys (hashes) and the usage statistics described in [PRIVACY.md](PRIVACY.md). None of these hold passwords, emails, names or health data. The operator cannot read a user's Garmin token from KV alone.
- The operator can change the Worker's code, and modified code could capture passwords as they pass through. Run your own copy if you do not trust someone else's deployment; this repository is the whole thing.
- Secrets (`TURNSTILE_SECRET`, `HASH_KEY`) are set with `wrangler secret`, never committed.
- Left over: trust in the operator of a shared deployment cannot be removed, only reduced.

## Garmin changes

Risk: Garmin changes or blocks the unofficial endpoints Pons uses.

- Garmin has no public API for this. Pons uses the same endpoints as Garmin's mobile app, which can change or be blocked without notice.
- Only `src/login/garmin.ts` and `src/garmin/api.ts` talk to Garmin, so a change stays in two files.
- Tools are read-only toward Garmin, so a bug cannot change anything in a Garmin account.
- Dependencies are pinned to exact versions and reviewed before upgrades.
- Left over: when Garmin breaks sign-in or an endpoint, Pons stops working until it is updated. Tools return a plain error that Claude can relay.
