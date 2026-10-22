// The /authorize endpoint: a sign-in page that checks the visitor is human, rate-limits
// attempts, logs in to Garmin (with a second page for the 2FA code when the account has one),
// then finishes the OAuth grant. The password and the code are only ever passed to Garmin.
// Logs hold outcome names only.

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { hmacHex } from "../crypto.js";
import type { Props } from "../garmin/api.js";
import { garminLogin, garminVerifyMfa, type LoginFailure, type LoginResult } from "./garmin.js";
import {
  clearMfaCookie,
  deleteMfaState,
  loadMfaState,
  MFA_MAX_ATTEMPTS,
  mfaCookie,
  newMfaExpiry,
  newMfaHandle,
  readMfaCookie,
  saveMfaState,
} from "./mfa.js";
import { loginPage, messagePage, mfaPage } from "./page.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_BODY = 10_000;

const MESSAGES: Record<Exclude<LoginFailure, "bad_code">, string> = {
  bad_credentials: "Garmin didn't accept that email or password.",
  rate_limited: "Garmin is limiting login attempts right now. Wait a few minutes and try again.",
  unavailable: "Couldn't reach Garmin. Try again in a moment.",
};
const EXPIRED = "This sign-in page expired. Go back to Claude and try connecting again.";
const NO_PERSON = "We couldn't confirm you're a person. Please try again.";
const TOO_MANY = "Too many tries. Wait a few minutes and try again.";

const logLogin = (outcome: string) => console.log(JSON.stringify({ pons_login: outcome }));

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
async function gate(request: Request, env: Env, turnstileToken: string, accountKey: string): Promise<string | undefined> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await verifyTurnstile(turnstileToken, ip, env.TURNSTILE_SECRET))) {
    logLogin("turnstile_failed");
    return NO_PERSON;
  }
  const [byIp, byAccount] = await Promise.all([
    env.LOGIN_LIMIT.limit({ key: "ip:" + ip }),
    env.LOGIN_LIMIT.limit({ key: accountKey }),
  ]);
  if (!byIp.success || !byAccount.success) {
    logLogin("rate_limited_here");
    return TOO_MANY;
  }
  return undefined;
}

/** The login form with a fresh single-use consent handle. */
async function renderLogin(request: Request, env: Env, nonce: string, error?: string): Promise<Response> {
  try {
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const client = await env.OAUTH_PROVIDER.describeConsent(authRequest);
    const consent = await env.OAUTH_PROVIDER.beginConsent(authRequest);
    const url = new URL(request.url);
    const res = loginPage({
      nonce,
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
    return messagePage(nonce, "This sign-in link isn't valid. Go back to Claude and try connecting again.");
  }
}

/** Create the grant and send the browser back to the client. */
async function finish(
  env: Env,
  request: AuthRequest,
  login: Extract<LoginResult, { ok: true }>,
  headers: Headers,
): Promise<Response> {
  const props: Props = { garmin: login.auth, displayName: login.displayName };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request,
    userId: await hmacHex(env.HASH_KEY, "garmin:" + login.garminId),
    metadata: {},
    scope: request.scope,
    props,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

/** A dead end that also drops the 2FA cookie. */
function mfaGone(nonce: string, text: string): Response {
  const res = messagePage(nonce, text);
  res.headers.append("Set-Cookie", clearMfaCookie());
  return res;
}

/** The second step: the 2FA code. The password step saved the Garmin session under the cookie's handle. */
async function handleMfaCode(request: Request, env: Env, nonce: string, field: (name: string) => string): Promise<Response> {
  const handle = readMfaCookie(request);
  const state = handle ? await loadMfaState(env, handle) : null;
  if (!handle || !state) return mfaGone(nonce, EXPIRED);

  const form = (error: string) => mfaPage({ nonce, action: new URL(request.url).pathname, siteKey: env.TURNSTILE_SITE_KEY, error });
  const code = field("code").replace(/\s+/g, "");
  if (!/^\d{4,10}$/.test(code)) return form("Enter the code Garmin sent you.");
  const stop = await gate(request, env, field("cf-turnstile-response"), "mfa:" + state.emailKey);
  if (stop) return form(stop);

  const result = await garminVerifyMfa(state, code);
  if (result.ok) {
    logLogin("mfa_ok");
    await deleteMfaState(env, handle);
    return finish(env, state.request, result, new Headers({ "Cache-Control": "no-store", "Set-Cookie": clearMfaCookie() }));
  }
  if (result.reason === "bad_code") {
    logLogin("bad_code");
    const attempts = state.attempts + 1;
    if (attempts >= MFA_MAX_ATTEMPTS) {
      await deleteMfaState(env, handle);
      return mfaGone(nonce, "That code didn't work three times. Go back to Claude and try connecting again.");
    }
    await saveMfaState(env, handle, { ...state, attempts });
    const left = MFA_MAX_ATTEMPTS - attempts;
    return form(`That code didn't work. You have ${left} ${left === 1 ? "try" : "tries"} left.`);
  }
  logLogin(result.reason);
  return form(MESSAGES[result.reason === "mfa_required" ? "unavailable" : result.reason]);
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  if (request.method === "GET") return renderLogin(request, env, nonce);
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) return new Response("Too large", { status: 413 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return renderLogin(request, env, nonce, "Enter your email and password.");
  }
  const text = (name: string) => (typeof form.get(name) === "string" ? (form.get(name) as string) : "");
  if (text("step") === "mfa") return handleMfaCode(request, env, nonce, text);

  const email = text("email").trim();
  const password = text("password");
  const handle = text("handle");
  if (!email || !password || !handle) return renderLogin(request, env, nonce, "Enter your email and password.");

  const emailKey = "email:" + (await hmacHex(env.HASH_KEY, "email:" + email.toLowerCase()));
  const stop = await gate(request, env, text("cf-turnstile-response"), emailKey);
  if (stop) return renderLogin(request, env, nonce, stop);

  let approved;
  try {
    approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
  } catch {
    return messagePage(nonce, EXPIRED);
  }

  const result = await garminLogin(email, password);
  if (result.ok) {
    logLogin("ok");
    return finish(env, approved.request, result, new Headers(approved.headers));
  }
  if (result.reason === "mfa_required") {
    logLogin("mfa_required");
    const mfaHandle = newMfaHandle();
    await saveMfaState(env, mfaHandle, {
      ...result.pending,
      request: approved.request,
      emailKey,
      attempts: 0,
      expiresAt: newMfaExpiry(),
    });
    const res = mfaPage({ nonce, action: new URL(request.url).pathname, siteKey: env.TURNSTILE_SITE_KEY });
    // Clear the consent cookie, which is used up, and bind the 2FA step to this browser.
    for (const cookie of approved.headers.getSetCookie()) res.headers.append("Set-Cookie", cookie);
    res.headers.append("Set-Cookie", mfaCookie(mfaHandle));
    return res;
  }
  logLogin(result.reason);
  return renderLogin(request, env, nonce, MESSAGES[result.reason === "bad_code" ? "unavailable" : result.reason]);
}
