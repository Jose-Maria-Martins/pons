import { afterEach, describe, expect, it, vi } from "vitest";
import { json, mockFetch, on, openLoginPage, PKCE_VERIFIER, post, REDIRECT, send } from "./helpers.js";

const API = "https://connectapi.garmin.com";

afterEach(() => vi.restoreAllMocks());

/** Full OAuth flow with a fake Garmin: returns an access token for the MCP endpoint. */
async function connect(): Promise<string> {
  const { path, handle, cookie, clientId } = await openLoginPage();
  mockFetch(
    on("https://challenges.cloudflare.com/", () => json({ success: true })),
    on("https://sso.garmin.com/", () => json({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-fake-1" })),
    on("https://diauth.garmin.com/", () => json({ access_token: "fake-garmin-access", refresh_token: "fake-refresh", expires_in: 3600 })),
    on(`${API}/userprofile-service/socialProfile`, () => json({ displayName: "fake-display-name", garminGUID: "fake-guid", fullName: "Test Person" })),
  );
  const done = await post(path, cookie, { handle, email: "someone@example.com", password: "fake-password", "cf-turnstile-response": "ok" });
  const code = new URL(done.headers.get("Location") ?? "").searchParams.get("code") ?? "";
  vi.restoreAllMocks();

  const token = await send("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: PKCE_VERIFIER }),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

const rpc = (accessToken: string | null, method: string, params: object = {}) =>
  send("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

/** The JSON-RPC message in a response that is either plain JSON or an SSE stream. */
interface ToolsMessage {
  result: {
    tools: { name: string; annotations: { readOnlyHint: boolean } }[];
    isError?: boolean;
    content: { type: string; text: string }[];
  };
}

async function message(res: Response): Promise<ToolsMessage> {
  const text = await res.text();
  const data = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "data: {}").slice(6);
  return JSON.parse(data);
}

describe("/mcp", () => {
  it("answers 401 with a pointer to the OAuth metadata when there is no token", async () => {
    const res = await rpc(null, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("lists exactly the three read-only tools", async () => {
    const token = await connect();
    const res = await rpc(token, "tools/list");
    expect(res.status).toBe(200);
    const tools = (await message(res)).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["connection_status", "daily_overview", "sleep_history"]);
    expect(tools.every((t) => t.annotations.readOnlyHint === true)).toBe(true);
  });

  it("runs a tool with the Garmin token stored in the grant", async () => {
    const token = await connect();
    const { spy } = mockFetch(
      on(`${API}/userprofile-service/socialProfile`, () => json({ fullName: "Test Person" })),
      on(`${API}/userprofile-service/userprofile/user-settings`, () => json({ userData: { measurementSystem: "metric" } })),
      on(`${API}/wellness-service/wellness/syncTimestamp`, () => json("2030-03-14T07:00:00.0")),
    );

    const res = await rpc(token, "tools/call", { name: "connection_status", arguments: {} });
    const result = (await message(res)).result;

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ connected: true, name: "Test Person", units: "metric", last_sync: "2030-03-14T07:00:00.0" });
    const headers = spy.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fake-garmin-access");
  });

  it("returns a bad date as an isError result", async () => {
    const token = await connect();
    const res = await rpc(token, "tools/call", { name: "daily_overview", arguments: { date: "not-a-date" } });
    const result = (await message(res)).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Invalid input/);
  });

  it("returns Garmin being unreachable as an isError result", async () => {
    const token = await connect();
    mockFetch(() => json({}, 503));
    const res = await rpc(token, "tools/call", { name: "sleep_history", arguments: {} });
    const result = (await message(res)).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Could not reach Garmin/);
  });
});
