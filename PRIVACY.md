# Pons privacy

Pons lets Claude read your Garmin Connect data. It is a hobby project run by one person. It is not affiliated with Garmin or Anthropic. The same text is served at `/privacy`.

## What Pons collects

Usage statistics only, and nothing about your health:

- Each time Claude uses a Pons tool: which tool, whether it worked (or the kind of error), how long it took, a user code, and the kind of device the request came from (desktop, web, mobile or other).
- Each time Claude connects: the name and version of the app.
- Each sign-in attempt: the outcome only, such as ok or wrong password.

The user code is a scrambled code made from your Garmin account id and a secret key. It is not your Garmin id, name or email. Cloudflare keeps these statistics for about three months.

To limit abuse, Pons also counts sign-in attempts per IP address and per scrambled email for a minute. Cloudflare keeps those counters briefly.

## What Pons stores

- A Garmin login token (not your password), encrypted, in the connection that lets Claude keep reading your data. It is kept for up to 30 days.
- If your account uses two-step verification, the half-finished sign-in, encrypted, for up to 10 minutes.

## What Pons never stores

- Your Garmin password. It goes straight to Garmin and is held in memory for that one request.
- Your health data. Pons reads it from Garmin when Claude asks and passes it on; it does not keep a copy. What Claude does with it is covered by Anthropic's own policies.

## Delete everything

Ask Claude to disconnect Pons. That deletes the stored connection and the Garmin token. Then remove the Pons connector in Claude's settings.

## Contact

Questions or problems: [github.com/Jose-Maria-Martins/pons](https://github.com/Jose-Maria-Martins/pons).
