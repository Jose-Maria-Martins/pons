// The /authorize endpoint: a sign-in page that checks the visitor is human, rate-limits
// attempts, logs in to Garmin, then finishes the OAuth grant. The password is only ever
// passed to Garmin. Logs hold outcome names only.

import { garminLogin, type LoginResult } from "./garmin.js";
import { loginPage, messagePage } from "./page.js";
import type { Props } from "../garmin/api.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_BODY = 10_000;

const MESSAGES: Record<Extract<LoginResult, { ok: false }>["reason"], string> = {
  bad_credentials: "Garmin didn't accept that email or password.",
  mfa_required:
    "This Garmin account uses two-step verification (2FA). Support for 2FA accounts is coming in the next version of Pons.",
  rate_limited: "Garmin is limiting login attempts right now. Wait a few minutes and try again.",
  unavailable: "Couldn't reach Garmin. Try again in a moment.",
};
const EXPIRED = "This sign-in page expired. Go back to Claude and try connecting again.";

const bytes = new TextEncoder();

export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", bytes.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, bytes.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  const email = text("email").trim();
  const password = text("password");
  const handle = text("handle");
  if (!email || !password || !handle) return renderLogin(request, env, nonce, "Enter your email and password.");

  // Before any Garmin request: prove it's a person, then apply the rate limits.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await verifyTurnstile(text("cf-turnstile-response"), ip, env.TURNSTILE_SECRET))) {
    console.log(JSON.stringify({ pons_login: "turnstile_failed" }));
    return renderLogin(request, env, nonce, "We couldn't confirm you're a person. Please try again.");
  }
  const emailKey = "email:" + (await hmacHex(env.HASH_KEY, "email:" + email.toLowerCase()));
  const [byIp, byEmail] = await Promise.all([
    env.LOGIN_LIMIT.limit({ key: "ip:" + ip }),
    env.LOGIN_LIMIT.limit({ key: emailKey }),
  ]);
  if (!byIp.success || !byEmail.success) {
    console.log(JSON.stringify({ pons_login: "rate_limited_here" }));
    return renderLogin(request, env, nonce, "Too many tries. Wait a few minutes and try again.");
  }

  let approved;
  try {
    approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
  } catch {
    return messagePage(nonce, EXPIRED);
  }

  const result = await garminLogin(email, password);
  console.log(JSON.stringify({ pons_login: result.ok ? "ok" : result.reason }));
  if (!result.ok) return renderLogin(request, env, nonce, MESSAGES[result.reason]);

  const props: Props = { garmin: result.auth, displayName: result.displayName };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: approved.request,
    userId: await hmacHex(env.HASH_KEY, "garmin:" + result.garminId),
    metadata: {},
    scope: approved.request.scope,
    props,
  });
  const headers = new Headers(approved.headers);
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}
