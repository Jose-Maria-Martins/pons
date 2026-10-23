// Garmin sign-in: mobile SSO login -> (2FA code) -> DI token exchange -> profile, and the DI token refresh.
// The password and the 2FA code go to Garmin and nowhere else: they are never stored or logged.

import { API_BASE, NATIVE_HEADERS, type GarminAuth } from "../garmin/api.js";

const SSO_BASE = "https://sso.garmin.com/mobile/api";
const SSO_QUERY =
  "?clientId=GCM_IOS_DARK&locale=en-US&service=https%3A%2F%2Fmobile.integration.garmin.com%2Fgcm%2Fios";
const IOS_SERVICE = "https://mobile.integration.garmin.com/gcm/ios";
const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const SSO_HEADERS = {
  "User-Agent": IOS_UA,
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  Origin: "https://sso.garmin.com",
};
const DI_TOKEN = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const DI_GRANT = "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket";
// Tried in order: Garmin retires old app ids over time.
export const DI_CLIENT_IDS = [
  "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2",
  "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4",
  "GARMIN_CONNECT_MOBILE_ANDROID_DI",
  "GARMIN_CONNECT_MOBILE_IOS_DI",
];

/** What is needed to finish a sign-in once the user has the 2FA code. */
export interface MfaPending {
  /** The Garmin SSO session cookies from the login response, as a Cookie header value. */
  cookies: string;
  /** How Garmin sent the code (for example "email"). */
  method: string;
}

export type LoginFailure = "bad_credentials" | "bad_code" | "rate_limited" | "unavailable";

export type LoginResult =
  | { ok: true; auth: GarminAuth; displayName: string; garminId: string }
  | { ok: false; reason: LoginFailure }
  | { ok: false; reason: "mfa_required"; pending: MfaPending };

type Failure = { ok: false; reason: LoginFailure };
const fail = (reason: LoginFailure): Failure => ({ ok: false, reason });

type Json = Record<string, unknown>;

async function readJson(res: Response): Promise<Json> {
  try {
    const j: unknown = await res.json();
    return typeof j === "object" && j !== null ? (j as Json) : {};
  } catch {
    return {};
  }
}

/** The name=value pairs of a response's Set-Cookie headers, as a Cookie header value. */
function sessionCookies(res: Response): string {
  const jar = new Map<string, string>();
  for (const cookie of res.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Garmin puts the app id it issued the token for in the JWT payload. Unverified; used only to pick the id to refresh with. */
function clientIdFromJwt(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const claims: unknown = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    const id = (claims as Json).client_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** POST to Garmin's DI token endpoint on behalf of an app id. */
function postDi(clientId: string, body: Record<string, string>): Promise<Response> {
  return fetch(DI_TOKEN, {
    method: "POST",
    headers: {
      ...NATIVE_HEADERS,
      Authorization: "Basic " + btoa(`${clientId}:`),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: new URLSearchParams({ client_id: clientId, ...body }),
  });
}

/** Step 1: email and password -> a one-time service ticket, a request for the 2FA code, or the reason it failed. */
async function signIn(email: string, password: string): Promise<{ ticket: string } | { mfa: MfaPending } | Failure> {
  const res = await fetch(`${SSO_BASE}/login${SSO_QUERY}`, {
    method: "POST",
    headers: SSO_HEADERS,
    body: JSON.stringify({ username: email, password, rememberMe: true, captchaToken: "" }),
  });
  if (res.status === 429) return fail("rate_limited");
  const cookies = sessionCookies(res);
  const body = await readJson(res);
  const type = (body.responseStatus as Json | undefined)?.type;
  if (type === "SUCCESSFUL" && typeof body.serviceTicketId === "string") return { ticket: body.serviceTicketId };
  if (type === "MFA_REQUIRED") {
    const method = (body.customerMfaInfo as Json | undefined)?.mfaLastMethodUsed;
    return { mfa: { cookies, method: typeof method === "string" && method ? method : "email" } };
  }
  if (type === "INVALID_USERNAME_PASSWORD") return fail("bad_credentials");
  return fail("unavailable");
}

/** Step 2 after 2FA: the code, with the SSO session from step 1 -> a one-time service ticket. */
async function verifyCode(pending: MfaPending, code: string): Promise<{ ticket: string } | Failure> {
  const res = await fetch(`${SSO_BASE}/mfa/verifyCode${SSO_QUERY}`, {
    method: "POST",
    headers: { ...SSO_HEADERS, Cookie: pending.cookies },
    body: JSON.stringify({
      mfaMethod: pending.method,
      mfaVerificationCode: code,
      rememberMyBrowser: true,
      reconsentList: [],
      mfaSetup: false,
    }),
  });
  if (res.status === 429) return fail("rate_limited");
  const body = await readJson(res);
  if ((body.error as Json | undefined)?.["status-code"] === "429") return fail("rate_limited");
  const type = (body.responseStatus as Json | undefined)?.type;
  if (type === "SUCCESSFUL" && typeof body.serviceTicketId === "string") return { ticket: body.serviceTicketId };
  // Garmin answers a wrong code with JSON; anything that is not JSON is a block page or an outage.
  return Object.keys(body).length > 0 ? fail("bad_code") : fail("unavailable");
}

/** Step 3: service ticket -> DI bearer token. */
async function exchangeTicket(ticket: string): Promise<GarminAuth | "rate_limited" | null> {
  for (const clientId of DI_CLIENT_IDS) {
    const res = await postDi(clientId, { service_ticket: ticket, grant_type: DI_GRANT, service_url: IOS_SERVICE });
    if (res.status === 429) return "rate_limited";
    if (!res.ok) continue;
    const body = await readJson(res);
    if (typeof body.access_token !== "string") continue;
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
    return {
      access: body.access_token,
      refresh: typeof body.refresh_token === "string" ? body.refresh_token : "",
      clientId: clientIdFromJwt(body.access_token) ?? clientId,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    };
  }
  return null;
}

/** Steps 3 and 4: a service ticket -> token and profile. Network failures become `unavailable`; nothing here throws. */
async function finishLogin(ticket: string): Promise<LoginResult> {
  try {
    const auth = await exchangeTicket(ticket);
    if (auth === "rate_limited") return fail("rate_limited");
    if (!auth) return fail("unavailable");

    const res = await fetch(`${API_BASE}/userprofile-service/socialProfile`, {
      headers: { ...NATIVE_HEADERS, Authorization: `Bearer ${auth.access}`, Accept: "application/json" },
    });
    if (!res.ok) return fail(res.status === 429 ? "rate_limited" : "unavailable");
    const profile = await readJson(res);
    const displayName = typeof profile.displayName === "string" ? profile.displayName : "";
    const garminId = String(profile.garminGUID ?? profile.profileId ?? "");
    if (!displayName || !garminId) return fail("unavailable");
    return { ok: true, auth, displayName, garminId };
  } catch {
    return fail("unavailable");
  }
}

/** Log in to Garmin. Network failures become `unavailable`; nothing here throws. */
export async function garminLogin(email: string, password: string): Promise<LoginResult> {
  try {
    const signedIn = await signIn(email, password);
    if ("reason" in signedIn) return signedIn;
    if ("mfa" in signedIn) return { ok: false, reason: "mfa_required", pending: signedIn.mfa };
    return await finishLogin(signedIn.ticket);
  } catch {
    return fail("unavailable");
  }
}

/** Finish a login that needed a 2FA code. A wrong code is `bad_code`; the session stays usable for another try. */
export async function garminVerifyMfa(pending: MfaPending, code: string): Promise<LoginResult> {
  try {
    const verified = await verifyCode(pending, code);
    if ("reason" in verified) return verified;
    return await finishLogin(verified.ticket);
  } catch {
    return fail("unavailable");
  }
}

export type RefreshResult =
  | { ok: true; auth: GarminAuth }
  | { ok: false; reason: "rejected" | "rate_limited" | "unavailable" };

/** Refresh Garmin's DI token the way the garminconnect library does. `rejected` means the login is gone for good. */
export async function refreshGarminAuth(auth: GarminAuth): Promise<RefreshResult> {
  if (!auth.refresh) return { ok: false, reason: "rejected" };
  let res: Response;
  try {
    res = await postDi(auth.clientId, { grant_type: "refresh_token", refresh_token: auth.refresh });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (res.status === 400 || res.status === 401) return { ok: false, reason: "rejected" };
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  if (!res.ok) return { ok: false, reason: "unavailable" };
  const body = await readJson(res);
  if (typeof body.access_token !== "string") return { ok: false, reason: "unavailable" };
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    ok: true,
    auth: {
      access: body.access_token,
      // Garmin may rotate the refresh token; keep the old one when it doesn't.
      refresh: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : auth.refresh,
      clientId: clientIdFromJwt(body.access_token) ?? auth.clientId,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    },
  };
}
