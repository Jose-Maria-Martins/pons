# Security

Pons asks people to type their Garmin password into a page it serves. That deserves a written threat model. This is a stub: each heading names a risk and the controls that exist today. Fuller write-ups come in later milestones.

To report a vulnerability, open a private security advisory on this repository.

## Password in transit

- The password travels from the browser to Pons over HTTPS and from Pons to `sso.garmin.com` over HTTPS. It is held in memory for one request.
- It is never stored, logged or echoed back. Logs hold outcome names and status codes only.
- The sign-in page sends a strict Content-Security-Policy (scripts only from a per-request nonce and Cloudflare Turnstile), `frame-ancestors 'none'`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

## Token theft

- Garmin's token is stored in the OAuth grant in Workers KV, encrypted by `@cloudflare/workers-oauth-provider` with a key that only the holder of the access token can unwrap.
- Claude's access tokens last one hour; refresh tokens last 30 days.
- The Garmin token can read health data. It is limited to what Garmin allows that mobile client.
- Planned: a disconnect action that revokes the grant.

## Abuse of the login page

- Cloudflare Turnstile is verified server-side before any Garmin request.
- Attempts are rate-limited per IP and, separately, per email (an HMAC, never the email itself), before any Garmin request.
- The consent handle is single-use and bound to the browser by a cookie, which blocks login CSRF.
- Planned: tool rate limits so one user cannot get Pons blocked by Garmin.

## Operator access

- The operator can see Worker logs (outcome names only) and KV keys, which hold hashes. The operator cannot read a user's Garmin token from KV alone.
- The operator can change the Worker's code. Run your own copy if you do not trust someone else's deployment; this repository is the whole thing.
- Secrets (`TURNSTILE_SECRET`, `HASH_KEY`) are set with `wrangler secret`, never committed.

## Garmin changes

- Garmin has no public API for this. Pons uses the same endpoints as Garmin's mobile app, which can change or be blocked without notice.
- Only `src/login/garmin.ts` and `src/garmin/api.ts` talk to Garmin, so a change stays in two files.
- Dependencies are pinned to exact versions and reviewed before upgrades.
