// Usage analytics (Cloudflare Analytics Engine). Only the fields below are ever written: no health
// values, emails, names or tokens. The same list is published in PRIVACY.md and at /privacy.

import { AsyncLocalStorage } from "node:async_hooks";

export type Platform = "desktop" | "web" | "mobile" | "other";

/**
 * What a data point holds. Layout in Analytics Engine:
 *   index1 = user id (an HMAC of the Garmin id, empty at login), blob1 = type, blob2 = name,
 *   blob3 = detail, blob4 = platform, double1 = milliseconds.
 */
export type PonsEvent =
  /** A tool call: tool name, "ok" or an error kind, time taken. */
  | { type: "tool"; name: string; detail: string; ms: number; platform: Platform; userId?: string }
  /** An MCP initialize: the client's name and version. */
  | { type: "initialize"; name: string; detail: string; platform: Platform; userId?: string }
  /** A sign-in attempt: the outcome name only. */
  | { type: "login"; name: string; platform: Platform };

/** Desktop, web or mobile, guessed from the User-Agent. Anything unrecognised is "other". */
export function platformOf(userAgent: string | null): Platform {
  const ua = (userAgent ?? "").toLowerCase();
  if (/android|iphone|ipad|ios|mobile/.test(ua)) return "mobile";
  if (/electron|desktop/.test(ua)) return "desktop";
  if (/mozilla|chrome|safari|firefox/.test(ua)) return "web";
  return "other";
}

const clip = (s: string) => s.slice(0, 100);

export function dataPoint(e: PonsEvent): AnalyticsEngineDataPoint {
  const userId = "userId" in e ? (e.userId ?? "") : "";
  return {
    indexes: [userId],
    blobs: [e.type, clip(e.name), clip("detail" in e ? e.detail : ""), e.platform],
    doubles: [e.type === "tool" ? e.ms : 0],
  };
}

/** Record an event. Never throws: analytics must not break a request. */
export function track(env: Env, event: PonsEvent): void {
  try {
    env.PONS_EVENTS.writeDataPoint(dataPoint(event));
  } catch {
    // Nothing to do: losing a data point is fine.
  }
}

/** What the tools need to know about the request that is running them. */
export interface RequestContext {
  env: Env;
  platform: Platform;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** The client name and version from an MCP initialize request, if the body is one. */
export function initializeInfo(body: unknown): { name: string; version: string } | undefined {
  for (const message of Array.isArray(body) ? body : [body]) {
    const m = message as { method?: unknown; params?: { clientInfo?: { name?: unknown; version?: unknown } } } | null;
    if (m?.method !== "initialize") continue;
    const info = m.params?.clientInfo;
    return { name: typeof info?.name === "string" ? info.name : "unknown", version: typeof info?.version === "string" ? info.version : "" };
  }
  return undefined;
}
