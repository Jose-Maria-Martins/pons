// Garmin sign-in: mobile SSO login -> DI token exchange -> profile.
// The password goes to Garmin and nowhere else: it is never stored or logged.

import { API_BASE, NATIVE_HEADERS, type GarminAuth } from "../garmin/api.js";

const SSO_LOGIN =
  "https://sso.garmin.com/mobile/api/login?clientId=GCM_IOS_DARK&locale=en-US" +
  "&service=https%3A%2F%2Fmobile.integration.garmin.com%2Fgcm%2Fios";
const IOS_SERVICE = "https://mobile.integration.garmin.com/gcm/ios";
const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const DI_TOKEN = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const DI_GRANT = "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket";
// Tried in order: Garmin retires old app ids over time.
export const DI_CLIENT_IDS = [
  "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2",
  "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4",
  "GARMIN_CONNECT_MOBILE_ANDROID_DI",
  "GARMIN_CONNECT_MOBILE_IOS_DI",
];

export type LoginResult =
  | { ok: true; auth: GarminAuth; displayName: string; garminId: string }
  | { ok: false; reason: "bad_credentials" | "mfa_required" | "rate_limited" | "unavailable" };

type Failure = Extract<LoginResult, { ok: false }>;
const fail = (reason: Failure["reason"]): Failure => ({ ok: false, reason });

type Json = Record<string, unknown>;

async function readJson(res: Response): Promise<Json> {
  try {
    const j: unknown = await res.json();
    return typeof j === "object" && j !== null ? (j as Json) : {};
  } catch {
    return {};
  }
}

/** Step 1: email and password -> a one-time service ticket (or the reason it failed). */
async function signIn(email: string, password: string): Promise<{ ticket: string } | Failure> {
  const res = await fetch(SSO_LOGIN, {
    method: "POST",
    headers: {
      "User-Agent": IOS_UA,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: "https://sso.garmin.com",
    },
    body: JSON.stringify({ username: email, password, rememberMe: true, captchaToken: "" }),
  });
  if (res.status === 429) return fail("rate_limited");
  const body = await readJson(res);
  const type = (body.responseStatus as Json | undefined)?.type;
  if (type === "SUCCESSFUL" && typeof body.serviceTicketId === "string") return { ticket: body.serviceTicketId };
  if (type === "MFA_REQUIRED") return fail("mfa_required");
  if (type === "INVALID_USERNAME_PASSWORD") return fail("bad_credentials");
  return fail("unavailable");
}

/** Step 2: service ticket -> DI bearer token. */
async function exchangeTicket(ticket: string): Promise<GarminAuth | "rate_limited" | null> {
  for (const clientId of DI_CLIENT_IDS) {
    const res = await fetch(DI_TOKEN, {
      method: "POST",
      headers: {
        ...NATIVE_HEADERS,
        Authorization: "Basic " + btoa(`${clientId}:`),
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
      },
      body: new URLSearchParams({
        client_id: clientId,
        service_ticket: ticket,
        grant_type: DI_GRANT,
        service_url: IOS_SERVICE,
      }),
    });
    if (res.status === 429) return "rate_limited";
    if (!res.ok) continue;
    const body = await readJson(res);
    if (typeof body.access_token !== "string") continue;
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
    return {
      access: body.access_token,
      refresh: typeof body.refresh_token === "string" ? body.refresh_token : "",
      clientId,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    };
  }
  return null;
}

/** Log in to Garmin. Network failures become `unavailable`; nothing here throws. */
export async function garminLogin(email: string, password: string): Promise<LoginResult> {
  try {
    const signedIn = await signIn(email, password);
    if ("reason" in signedIn) return signedIn;

    const auth = await exchangeTicket(signedIn.ticket);
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
