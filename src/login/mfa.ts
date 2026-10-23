// The half-finished sign-in of an account with two-step verification (2FA).
// Between the password and the code we keep Garmin's SSO session cookies and the approved OAuth
// request in KV for 10 minutes. The value is AES-GCM encrypted with a key derived (HKDF) from the
// handle and HASH_KEY, and the KV key is a keyed hash of the handle, so KV alone reveals nothing.
// The handle itself only lives in the user's browser, in a __Host- cookie.

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { hmacHex } from "../crypto.js";
import type { MfaPending } from "./garmin.js";

export const MFA_COOKIE = "__Host-pons_mfa";
export const MFA_TTL_SECONDS = 600;
export const MFA_MAX_ATTEMPTS = 3;
const KV_MIN_TTL = 60;

export interface MfaState extends MfaPending {
  /** The OAuth request the user approved on the first page. */
  request: AuthRequest;
  /** Keyed hash of the email, so code attempts count against the same account. */
  emailKey: string;
  /** Wrong codes so far. */
  attempts: number;
  /** Unix seconds. */
  expiresAt: number;
}

const text = new TextEncoder();

const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(hashKey: string, handle: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", text.encode(hashKey), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: text.encode(handle), info: text.encode("pons-mfa-state-v1") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const kvKey = async (env: Env, handle: string) => "mfa:" + (await hmacHex(env.HASH_KEY, "mfa:" + handle));

/** A fresh random handle (256 bits). */
export function newMfaHandle(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function saveMfaState(env: Env, handle: string, state: MfaState): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(env.HASH_KEY, handle);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, text.encode(JSON.stringify(state)));
  const stored = new Uint8Array(iv.length + data.byteLength);
  stored.set(iv);
  stored.set(new Uint8Array(data), iv.length);
  const remaining = state.expiresAt - Math.floor(Date.now() / 1000);
  await env.OAUTH_KV.put(await kvKey(env, handle), toBase64(stored), {
    expirationTtl: Math.max(KV_MIN_TTL, remaining),
  });
}

/** The saved state, or null when the handle is unknown, expired or the value does not decrypt. */
export async function loadMfaState(env: Env, handle: string): Promise<MfaState | null> {
  try {
    const stored = await env.OAUTH_KV.get(await kvKey(env, handle));
    if (!stored) return null;
    const bytes = fromBase64(stored);
    const key = await deriveKey(env.HASH_KEY, handle);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    const state = JSON.parse(new TextDecoder().decode(plain)) as MfaState;
    return state.expiresAt > Math.floor(Date.now() / 1000) ? state : null;
  } catch {
    return null;
  }
}

export async function deleteMfaState(env: Env, handle: string): Promise<void> {
  await env.OAUTH_KV.delete(await kvKey(env, handle));
}

export const newMfaExpiry = () => Math.floor(Date.now() / 1000) + MFA_TTL_SECONDS;

export const mfaCookie = (handle: string): string =>
  `${MFA_COOKIE}=${handle}; Max-Age=${MFA_TTL_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax`;

export const clearMfaCookie = (): string => `${MFA_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;

export function readMfaCookie(request: Request): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === MFA_COOKIE) return value.join("=") || undefined;
  }
  return undefined;
}
