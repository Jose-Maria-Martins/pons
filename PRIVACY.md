# Pons privacy

Pons lets AI apps such as Claude, ChatGPT and Gemini read your Garmin Connect data. It is a hobby project run by one person. It is not affiliated with Garmin, Anthropic, OpenAI or Google. It is open source: the code is in this repository. The same text is served at `/privacy`.

## What Pons collects

Usage statistics only, and nothing about your health:

- Each time your AI app uses a Pons tool: which tool, whether it worked (or the kind of error), how long it took, a user code, and the kind of device the request came from (desktop, web, mobile or other).
- Each time an AI app connects: the name and version of the app.
- Each sign-in attempt: the outcome only, such as ok or wrong password.

The user code is a scrambled code made from your Garmin account id and a secret key. It is not your Garmin id, name or email. Cloudflare keeps these statistics for about three months.

To limit abuse, Pons also counts sign-in attempts per IP address and per scrambled email for a minute. Cloudflare keeps those counters briefly.

## What Pons stores

- A Garmin login token (not your password), encrypted, in the connection that lets your AI app keep reading your data. It is kept for up to 90 days.
- Your Garmin time zone (for example Europe/London), in the same connection, so "today" means your local date.
- If your account uses two-step verification, the half-finished sign-in, encrypted, for up to 10 minutes.
- Your language choice, if you pick one, in a cookie in your own browser for one year.

## What Pons never stores

- Your Garmin password. It goes straight to Garmin and is held in memory for that one request.
- Your health data. Pons reads it from Garmin when your AI app asks and passes it on; it does not keep a copy. What your AI app does with it is covered by that app's own privacy policy.

## Delete everything

Ask your AI app to disconnect Pons. That deletes the stored connection and the Garmin token. Then remove Pons from the app's connector settings.

## Contact

Questions or problems: open an issue in this repository.

The `/privacy` page shows the same contact line only when the person running Pons has set `SOURCE_URL`. Without it, the page says to contact the person who shared Pons with you.
