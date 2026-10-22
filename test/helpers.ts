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

export const post = (path: string, cookie: string, fields: Record<string, string>) =>
  send(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams(fields),
  });

