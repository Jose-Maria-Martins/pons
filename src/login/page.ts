// The sign-in page shown at /authorize. Look and wording follow the local claudeGarmin login page.

import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { LANGUAGES, STRINGS, type Lang } from "./i18n.js";

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const STYLE = `
:root{--bg:#f4f5f7;--card:#fff;--text:#1d2330;--muted:#5b6475;--accent:#0a66c2;--accent-text:#fff;--border:#c4cad6;--error:#b3261e;--ok:#1b7a3d}
@media (prefers-color-scheme:dark){:root{--bg:#14171d;--card:#1e222b;--text:#eceff4;--muted:#a5adbd;--accent:#5aa9ff;--accent-text:#0b1220;--border:#444c5c;--error:#ff8a80;--ok:#6fdc8c}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:20px/1.5 system-ui,sans-serif}
main{box-sizing:border-box;width:min(30rem,calc(100% - 2rem));padding:2rem;background:var(--card);border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.12)}
h1{margin:0 0 .5rem;font-size:1.6rem}
h2{margin:1.5rem 0 .25rem;font-size:1.1rem}
ul{margin:.5rem 0;padding-left:1.25rem}li{margin:.25rem 0}
a{color:var(--accent)}
p{margin:.5rem 0}.muted{color:var(--muted);font-size:.9rem}.error{color:var(--error);font-weight:600}
label{display:block;margin-top:1rem;font-weight:600}
input{box-sizing:border-box;width:100%;margin-top:.25rem;padding:.7rem;font:inherit;color:var(--text);background:var(--bg);border:2px solid var(--border);border-radius:10px}
button{margin-top:1.5rem;width:100%;padding:.8rem;font:inherit;font-weight:700;color:var(--accent-text);background:var(--accent);border:0;border-radius:10px;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.lang{margin:0 0 .5rem;text-align:right;color:var(--muted);font-size:.9rem}.lang a{color:var(--muted)}
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
  lang: Lang;
  /** Form action: the /authorize URL with the original OAuth query string. */
  action: string;
  /** Single-use consent handle from the OAuth library. */
  handle: string;
  siteKey: string;
  client: ConsentDescription;
  error?: string;
}

interface ShellOptions {
  nonce: string;
  lang: Lang;
  body: string;
  script?: string;
  title?: string;
  /** The language switch, for pages a plain link can reach. */
  nav?: string;
}

function shell({ nonce, lang, body, script = "", title = STRINGS[lang].title, nav = "" }: ShellOptions): Response {
  const html = `<!doctype html>
<html lang="${STRINGS[lang].htmlLang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/icon.png">
<title>${title}</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main>${nav}<h1>${title}</h1>${body}</main>${script}</body></html>`;
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
        "img-src 'self'",
        "frame-src https://challenges.cloudflare.com",
        "connect-src https://challenges.cloudflare.com",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}

/** "English · Português": the current language as text, the other as a link to this same page in it. */
function langNav(lang: Lang, current: string): string {
  const items = LANGUAGES.map((l) => {
    if (l.lang === lang) return `<span aria-current="true">${l.name}</span>`;
    const url = new URL(current, "https://pons.invalid");
    url.searchParams.set("lang", l.lang);
    const htmlLang = STRINGS[l.lang].htmlLang;
    return `<a href="${esc(url.pathname + url.search)}" lang="${htmlLang}" hreflang="${htmlLang}">${l.name}</a>`;
  });
  return `<nav class="lang" aria-label="Language / Idioma">${items.join(" · ")}</nav>`;
}

export function loginPage(o: LoginPageOptions): Response {
  const s = STRINGS[o.lang];
  const c = o.client;
  const who = c.clientDomain ?? c.redirectHost;
  const error = o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : "";
  const loopback = c.redirectIsLoopback ? `<p class="error">${s.loopback}</p>` : "";
  const body = `${error}
<p>${s.asking(esc(c.clientName), esc(who))}</p>${loopback}
<p class="muted">${s.passwordNote}</p>
<form method="post" action="${esc(o.action)}">
<input type="hidden" name="handle" value="${esc(o.handle)}">
<label>${s.email}<input name="email" type="email" autocomplete="username" required autofocus></label>
<label>${s.password}<input name="password" type="password" autocomplete="current-password" required></label>
<div class="cf-turnstile" data-sitekey="${esc(o.siteKey)}"></div>
<button type="submit">${s.signIn}</button>
<div id="working" hidden><div class="spin" role="status" aria-label="${s.signingInLabel}"></div>
<p>${s.signingIn}</p></div>
</form>
<p class="muted"><a href="/privacy" target="_blank" rel="noopener">${s.privacyLink}</a></p>`;
  const scripts = `<script nonce="${o.nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script nonce="${o.nonce}">${SUBMIT_SCRIPT}</script>`;
  return shell({ nonce: o.nonce, lang: o.lang, body, script: scripts, nav: langNav(o.lang, o.action) });
}

export interface MfaPageOptions {
  nonce: string;
  lang: Lang;
  action: string;
  siteKey: string;
  /** Tag of the sign-in this form belongs to (see mfaFingerprint). */
  fingerprint: string;
  error?: string;
}

/** The second step for accounts with two-step verification: the code Garmin just sent. */
export function mfaPage(o: MfaPageOptions): Response {
  const s = STRINGS[o.lang];
  const error = o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : "";
  const body = `${error}
<p>${s.mfaIntro}</p>
<p class="muted">${s.mfaNote}</p>
<form method="post" action="${esc(o.action)}">
<input type="hidden" name="step" value="mfa">
<input type="hidden" name="tab" value="${esc(o.fingerprint)}">
<label>${s.code}<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" required autofocus></label>
<div class="cf-turnstile" data-sitekey="${esc(o.siteKey)}"></div>
<button type="submit">${s.verify}</button>
<div id="working" hidden><div class="spin" role="status" aria-label="${s.verifyingLabel}"></div>
<p>${s.verifying}</p></div>
</form>`;
  const scripts = `<script nonce="${o.nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script nonce="${o.nonce}">${SUBMIT_SCRIPT}</script>`;
  return shell({ nonce: o.nonce, lang: o.lang, body, script: scripts });
}

/** A plain page with no form, for dead ends (expired link, invalid request). */
export function messagePage(nonce: string, lang: Lang, text: string, status = 400): Response {
  const res = shell({ nonce, lang, body: `<p class="error" role="alert">${esc(text)}</p>` });
  return new Response(res.body, { status, headers: res.headers });
}

/** The privacy page at /privacy. Keep it in step with PRIVACY.md and with what src/analytics.ts writes. */
export function privacyPage(sourceUrl: string, lang: Lang): Response {
  const s = STRINGS[lang];
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const source = sourceUrl.trim().replace(/\/+$/, "");
  const openSource = source ? s.openSource(`<a href="${esc(source)}" rel="noopener">${s.readTheCode}</a>`) : "";
  const contact = source
    ? s.contactIssue(`<a href="${esc(source)}/issues" rel="noopener">${esc(source)}/issues</a>`)
    : s.contactSharer;
  const list = (items: string[]) => `<ul>\n${items.map((i) => `<li>${i}</li>`).join("\n")}\n</ul>`;
  const body = `<p>${s.privacyIntro}${openSource}</p>
<h2>${s.collectsH}</h2>
<p>${s.collectsLead}</p>
${list(s.collectsItems)}
<p>${s.userCodeNote}</p>
<p>${s.abuseNote}</p>
<h2>${s.storesH}</h2>
${list(s.storesItems)}
<h2>${s.neverH}</h2>
${list(s.neverItems)}
<h2>${s.deleteH}</h2>
<p>${s.deleteText}</p>
<h2>${s.contactH}</h2>
<p>${s.contactLead}${contact}</p>`;
  return shell({ nonce, lang, body, title: s.privacyTitle, nav: langNav(lang, "/privacy") });
}
