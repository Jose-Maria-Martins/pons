import { exports } from "cloudflare:workers";
import { expect, vi } from "vitest";

type Handler = (url: URL, init?: RequestInit) => Response | undefined;

/** Replace global fetch with a router. Unmatched URLs throw, so a test fails if the code calls anything unexpected. */
export function mockFetch(...handlers: Handler[]) {
  const calls: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.origin + url.pathname);
    for (const h of handlers) {
      const res = h(url, init);
      if (res) return res;
    }
    throw new Error(`Unexpected fetch to ${url.origin}${url.pathname}`);
  });
  return { calls, spy };
}

export const on =
  (prefix: string, respond: () => Response): Handler =>
  (url) =>
    url.href.startsWith(prefix) ? respond() : undefined;

export const json = (body: unknown, status = 200) => Response.json(body, { status });

export const ORIGIN = "https://pons.example.test";
export const REDIRECT = "https://client.example/callback";
// Example from RFC 7636, appendix B.
export const PKCE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const PKCE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

export const send = (path: string, init?: RequestInit) => exports.default.fetch(new Request(ORIGIN + path, { redirect: "manual", ...init }));

async function registerClient(): Promise<string> {
  const res = await send("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Opens the login page like a browser would and returns what a form post needs. */
export async function openLoginPage() {
  const clientId = await registerClient();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "state-123",
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: "S256",
  });
  const path = `/authorize?${query}`;
  const page = await send(path);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { path, page, html, handle: handle ?? "", cookie, clientId };
}

export const post = (path: string, cookie: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  send(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, ...headers },
    body: new URLSearchParams(fields),
  });


export interface Connected {
  accessToken: string;
  refreshToken: string;
  clientId: string;
}

// Each connection uses its own address and email, so the login rate limits never get in the way.
let connections = 0;

/** Full OAuth flow with a fake Garmin. `garminExpiresIn` is how many seconds the fake Garmin token lasts. */
export async function connect(garminExpiresIn = 3600): Promise<Connected> {
  const n = ++connections;
  const { path, handle, cookie, clientId } = await openLoginPage();
  mockFetch(
    on("https://challenges.cloudflare.com/", () => json({ success: true })),
    on("https://sso.garmin.com/", () => json({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-fake-1" })),
    on("https://diauth.garmin.com/", () => json({ access_token: "fake-garmin-access", refresh_token: "fake-refresh", expires_in: garminExpiresIn })),
    on("https://connectapi.garmin.com/userprofile-service/socialProfile", () => json({ displayName: "fake-display-name", garminGUID: "fake-guid", fullName: "Test Person" })),
  );
  const done = await post(path, cookie, { handle, email: `connect${n}@example.com`, password: "fake-password", "cf-turnstile-response": "ok" }, { "CF-Connecting-IP": `192.0.2.${n % 250}` });
  const code = new URL(done.headers.get("Location") ?? "").searchParams.get("code") ?? "";
  vi.restoreAllMocks();
  return exchange({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: PKCE_VERIFIER }, clientId);
}

async function exchange(params: Record<string, string>, clientId: string): Promise<Connected> {
  const res = await tokenRequest(params);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { access_token: string; refresh_token: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token, clientId };
}

const tokenRequest = (params: Record<string, string>) =>
  send("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });

/** Pons's own refresh_token grant. Returns the raw response, so a test can look at failures. */
export const refreshRequest = (c: Pick<Connected, "refreshToken" | "clientId">) =>
  tokenRequest({ grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: c.clientId });

/** A refresh that must succeed: the next set of tokens. */
export async function refreshed(c: Connected): Promise<Connected> {
  return exchange({ grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: c.clientId }, c.clientId);
}

export const rpc = (accessToken: string | null, method: string, params: object = {}) =>
  send("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

/** A JSON-RPC reply as the tests read it. */
export interface RpcMessage {
  result: {
    tools: { name: string; title?: string; annotations: { readOnlyHint: boolean; destructiveHint?: boolean } }[];
    isError?: boolean;
    content: { type: string; text: string }[];
  };
}

/** The JSON-RPC message in a response that is either plain JSON or an SSE stream. */
export async function message(res: Response): Promise<RpcMessage> {
  const text = await res.text();
  const data = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "data: {}").slice(6);
  return JSON.parse(data);
}
