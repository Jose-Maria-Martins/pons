// The sign-in page shown at /authorize. Look and wording follow the local claudeGarmin login page.

import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const STYLE = `
:root{--bg:#f4f5f7;--card:#fff;--text:#1d2330;--muted:#5b6475;--accent:#0a66c2;--accent-text:#fff;--border:#c4cad6;--error:#b3261e;--ok:#1b7a3d}
@media (prefers-color-scheme:dark){:root{--bg:#14171d;--card:#1e222b;--text:#eceff4;--muted:#a5adbd;--accent:#5aa9ff;--accent-text:#0b1220;--border:#444c5c;--error:#ff8a80;--ok:#6fdc8c}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:20px/1.5 system-ui,sans-serif}
main{box-sizing:border-box;width:min(30rem,calc(100% - 2rem));padding:2rem;background:var(--card);border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.12)}
h1{margin:0 0 .5rem;font-size:1.6rem}
p{margin:.5rem 0}.muted{color:var(--muted);font-size:.9rem}.error{color:var(--error);font-weight:600}
label{display:block;margin-top:1rem;font-weight:600}
input{box-sizing:border-box;width:100%;margin-top:.25rem;padding:.7rem;font:inherit;color:var(--text);background:var(--bg);border:2px solid var(--border);border-radius:10px}
button{margin-top:1.5rem;width:100%;padding:.8rem;font:inherit;font-weight:700;color:var(--accent-text);background:var(--accent);border:0;border-radius:10px;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.cf-turnstile{margin-top:1rem}
.spin{width:2.5rem;height:2.5rem;margin:1.5rem auto .5rem;border:4px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite}
[hidden]{display:none}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation-duration:4s}}
`;

// Shows the spinner while Garmin signs in. Runs under the page's CSP nonce.
const SUBMIT_SCRIPT = `
const form = document.querySelector("form");
const reset = () => { form.querySelector("button").disabled = false; document.getElementById("working").hidden = true; };
form.addEventListener("submit", () => {
  form.querySelector("button").disabled = true;
  document.getElementById("working").hidden = false;
});
addEventListener("pageshow", reset);
`;

export interface LoginPageOptions {
  nonce: string;
  /** Form action: the /authorize URL with the original OAuth query string. */
  action: string;
  /** Single-use consent handle from the OAuth library. */
  handle: string;
  siteKey: string;
  client: ConsentDescription;
  error?: string;
}

function shell(nonce: string, body: string, script = ""): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your Garmin</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main><h1>Connect your Garmin</h1>${body}</main>${script}</body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' https://challenges.cloudflare.com`,
        `style-src 'nonce-${nonce}'`,
        "frame-src https://challenges.cloudflare.com",
        "connect-src https://challenges.cloudflare.com",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}

export function loginPage(o: LoginPageOptions): Response {
  const c = o.client;
  const who = c.clientDomain ?? c.redirectHost;
  const error = o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : "";
  const loopback = c.redirectIsLoopback
    ? `<p class="error">This request sends your login to an app on this device. Only continue if you started it.</p>`
    : "";
  const body = `${error}
<p><b>${esc(c.clientName)}</b> (${esc(who)}) is asking to read your Garmin data. Pons only reads it; it never changes anything in your Garmin account.</p>${loopback}
<p class="muted">Your password goes straight to Garmin. Pons never saves it; only a login token is stored, encrypted, so Claude can read your data.</p>
<form method="post" action="${esc(o.action)}">
<input type="hidden" name="handle" value="${esc(o.handle)}">
<label>Email<input name="email" type="email" autocomplete="username" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<div class="cf-turnstile" data-sitekey="${esc(o.siteKey)}"></div>
<button type="submit">Sign in</button>
<div id="working" hidden><div class="spin" role="status" aria-label="Signing in"></div>
<p>Signing in to Garmin&hellip; this can take up to a minute.</p></div>
</form>`;
  const scripts = `<script nonce="${o.nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script nonce="${o.nonce}">${SUBMIT_SCRIPT}</script>`;
  return shell(o.nonce, body, scripts);
}

/** A plain page with no form, for dead ends (expired link, invalid request). */
export function messagePage(nonce: string, text: string, status = 400): Response {
  const res = shell(nonce, `<p class="error" role="alert">${esc(text)}</p>`);
  return new Response(res.body, { status, headers: res.headers });
}
