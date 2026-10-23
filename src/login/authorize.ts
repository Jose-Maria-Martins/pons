// The /authorize endpoint: a sign-in page that checks the visitor is human, rate-limits
// attempts, logs in to Garmin (with a second page for the 2FA code when the account has one),
// then finishes the OAuth grant. The password and the code are only ever passed to Garmin.
// Logs hold outcome names only.

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { platformOf, track } from "../analytics.js";
import { hmacHex } from "../crypto.js";
import type { Props } from "../garmin/api.js";
import { readBounded } from "./body.js";
import { garminLogin, garminVerifyMfa, type LoginFailure, type LoginResult } from "./garmin.js";
import {
  clearMfaCookie,
  deleteMfaState,
  loadMfaState,
  MFA_MAX_ATTEMPTS,
  mfaCookie,
  mfaFingerprint,
  newMfaExpiry,
  newMfaHandle,
  readMfaCookie,
  saveMfaState,
} from "./mfa.js";
import { pickLang, STRINGS, type Lang, type Strings } from "./i18n.js";
import { loginPage, messagePage, mfaPage } from "./page.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_BODY = 10_000;

/** The text for a Garmin login failure. */
const failureText = (s: Strings, reason: Exclude<LoginFailure, "bad_code">): string =>
  ({ bad_credentials: s.badCredentials, rate_limited: s.rateLimited, unavailable: s.unavailable })[reason];

/** Log and count the outcome of a sign-in step. Outcome names only: nothing about the person. */
function logLogin(env: Env, request: Request, outcome: string) {
  console.log(JSON.stringify({ pons_login: outcome }));
  track(env, { type: "login", name: outcome, platform: platformOf(request.headers.get("User-Agent")) });
}

async function verifyTurnstile(token: string, ip: string, secret: string): Promise<boolean> {
  if (!token) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (ip !== "unknown") form.set("remoteip", ip);
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body: form });
    return ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    return false;
  }
}

/**
 * Before any Garmin request: prove it's a person, then apply the rate limits (per IP and per account).
 * Returns the message to show when the request must stop.
 */
async function gate(request: Request, env: Env, s: Strings, turnstileToken: string, accountKey: string): Promise<string | undefined> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await verifyTurnstile(turnstileToken, ip, env.TURNSTILE_SECRET))) {
    logLogin(env, request, "turnstile_failed");
    return s.noPerson;
  }
  const [byIp, byAccount] = await Promise.all([
    env.LOGIN_LIMIT.limit({ key: "ip:" + ip }),
    env.LOGIN_LIMIT.limit({ key: accountKey }),
  ]);
  if (!byIp.success || !byAccount.success) {
    logLogin(env, request, "rate_limited_here");
    return s.tooMany;
  }
  return undefined;
}

/** The login form with a fresh single-use consent handle. */
async function renderLogin(request: Request, env: Env, nonce: string, lang: Lang, error?: string): Promise<Response> {
  try {
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const client = await env.OAUTH_PROVIDER.describeConsent(authRequest);
    const consent = await env.OAUTH_PROVIDER.beginConsent(authRequest);
    const url = new URL(request.url);
    const res = loginPage({
      nonce,
      lang,
      action: url.pathname + url.search,
      handle: consent.handle,
      siteKey: env.TURNSTILE_SITE_KEY,
      client,
      error,
    });
    // The consent cookie binds the handle to this browser.
    for (const cookie of consent.headers.getSetCookie()) res.headers.append("Set-Cookie", cookie);
    return res;
  } catch {
    return messagePage(nonce, lang, STRINGS[lang].invalidLink);
  }
}

/** Create the grant and send the browser back to the client. */
async function finish(
  env: Env,
  request: AuthRequest,
  login: Extract<LoginResult, { ok: true }>,
  headers: Headers,
): Promise<Response> {
  const userId = await hmacHex(env.HASH_KEY, "garmin:" + login.garminId);
  const props: Props = { garmin: login.auth, displayName: login.displayName, userId, timeZone: login.timeZone };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request,
    userId,
    metadata: {},
    scope: request.scope,
    props,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

/** A dead end that also drops the 2FA cookie. */
function mfaGone(nonce: string, lang: Lang, text: string): Response {
  const res = messagePage(nonce, lang, text);
  res.headers.append("Set-Cookie", clearMfaCookie());
  return res;
}

/** The second step: the 2FA code. The password step saved the Garmin session under the cookie's handle. */
async function handleMfaCode(request: Request, env: Env, nonce: string, lang: Lang, field: (name: string) => string): Promise<Response> {
  const s = STRINGS[lang];
  const handle = readMfaCookie(request);
  const state = handle ? await loadMfaState(env, handle) : null;
  if (!handle || !state) return mfaGone(nonce, lang, s.expired);
  if (state.attempts >= MFA_MAX_ATTEMPTS) {
    await deleteMfaState(env, handle);
    return mfaGone(nonce, lang, s.outOfTries);
  }

  // Another tab may have started a newer sign-in and replaced the cookie: this page belongs to an older one.
  const fingerprint = await mfaFingerprint(handle);
  if (field("tab") !== fingerprint) return messagePage(nonce, lang, s.replaced);

  const form = (error: string) =>
    mfaPage({ nonce, lang, action: new URL(request.url).pathname, siteKey: env.TURNSTILE_SITE_KEY, fingerprint, error });
  const code = field("code").replace(/\s+/g, "");
  if (!/^\d{4,10}$/.test(code)) return form(s.missingCode);
  const stop = await gate(request, env, s, field("cf-turnstile-response"), "mfa:" + state.emailKey);
  if (stop) return form(stop);

  // Reserve the try before the slow call to Garmin, so a parallel submission sees it. KV is not atomic, so two
  // requests that load the state at the same moment can still both pass; the per-email LOGIN_LIMIT gate above
  // ("mfa:" + emailKey) is the hard bound.
  const attempts = state.attempts + 1;
  await saveMfaState(env, handle, { ...state, attempts });

  const result = await garminVerifyMfa(state, code);
  if (result.ok) {
    logLogin(env, request, "mfa_ok");
    await deleteMfaState(env, handle);
    return finish(env, state.request, result, new Headers({ "Cache-Control": "no-store", "Set-Cookie": clearMfaCookie() }));
  }
  if (result.reason === "bad_code") {
    logLogin(env, request, "bad_code");
    if (attempts >= MFA_MAX_ATTEMPTS) {
      await deleteMfaState(env, handle);
      return mfaGone(nonce, lang, s.outOfTries);
    }
    const left = MFA_MAX_ATTEMPTS - attempts;
    return form(s.triesLeft(left));
  }
  logLogin(env, request, result.reason);
  // Garmin never judged the code, so give the try back.
  await saveMfaState(env, handle, state);
  return form(failureText(s, result.reason === "mfa_required" ? "unavailable" : result.reason));
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const { lang, setCookie } = pickLang(request);
  const res = await authorize(request, env, lang);
  if (setCookie) res.headers.append("Set-Cookie", setCookie);
  return res;
}

async function authorize(request: Request, env: Env, lang: Lang): Promise<Response> {
  const s = STRINGS[lang];
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  if (request.method === "GET") return renderLogin(request, env, nonce, lang);
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // The header is a cheap first check; a body sent in chunks has none, so the read itself is also bounded.
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) return new Response("Too large", { status: 413 });
  let form: FormData;
  try {
    const bytes = await readBounded(request.body, MAX_BODY);
    if (!bytes) return new Response("Too large", { status: 413 });
    form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("Content-Type") ?? "" } }).formData();
  } catch {
    return renderLogin(request, env, nonce, lang, s.missingLogin);
  }
  const text = (name: string) => (typeof form.get(name) === "string" ? (form.get(name) as string) : "");
  if (text("step") === "mfa") return handleMfaCode(request, env, nonce, lang, text);

  const email = text("email").trim();
  const password = text("password");
  const handle = text("handle");
  if (!email || !password || !handle) return renderLogin(request, env, nonce, lang, s.missingLogin);

  const emailKey = "email:" + (await hmacHex(env.HASH_KEY, "email:" + email.toLowerCase()));
  const stop = await gate(request, env, s, text("cf-turnstile-response"), emailKey);
  if (stop) return renderLogin(request, env, nonce, lang, stop);

  let approved;
  try {
    approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
  } catch {
    return messagePage(nonce, lang, s.expired);
  }

  const result = await garminLogin(email, password);
  if (result.ok) {
    logLogin(env, request, "ok");
    return finish(env, approved.request, result, new Headers(approved.headers));
  }
  if (result.reason === "mfa_required") {
    logLogin(env, request, "mfa_required");
    const mfaHandle = newMfaHandle();
    await saveMfaState(env, mfaHandle, {
      ...result.pending,
      request: approved.request,
      emailKey,
      attempts: 0,
      expiresAt: newMfaExpiry(),
    });
    const fingerprint = await mfaFingerprint(mfaHandle);
    const res = mfaPage({ nonce, lang, action: new URL(request.url).pathname, siteKey: env.TURNSTILE_SITE_KEY, fingerprint });
    // Clear the consent cookie, which is used up, and bind the 2FA step to this browser.
    for (const cookie of approved.headers.getSetCookie()) res.headers.append("Set-Cookie", cookie);
    res.headers.append("Set-Cookie", mfaCookie(mfaHandle));
    return res;
  }
  logLogin(env, request, result.reason);
  return renderLogin(request, env, nonce, lang, failureText(s, result.reason === "bad_code" ? "unavailable" : result.reason));
}
