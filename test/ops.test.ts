import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dataPoint, initializeInfo, platformOf } from "../src/analytics.js";
import { hmacHex } from "../src/crypto.js";
import { tokenExchangeCallback } from "../src/index.js";
import { privacyPage } from "../src/login/page.js";
import { connect, json, message, mockFetch, on, openLoginPage, post, refreshRequest, rpc, send } from "./helpers.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const call = (token: string, name: string, args: object = {}) => rpc(token, "tools/call", { name, arguments: args });

afterEach(() => vi.restoreAllMocks());

describe("disconnect", () => {
  it("revokes every grant of the user and leaves other users alone", async () => {
    const first = await connect(3600, "ops-disconnect-a");
    const second = await connect(3600, "ops-disconnect-a");
    const other = await connect(3600, "ops-disconnect-b");

    const res = await call(first.accessToken, "disconnect");
    const result = (await message(res)).result;
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]?.text ?? "") as { disconnected: boolean; connections_removed: number; message: string };
    expect(body.disconnected).toBe(true);
    expect(body.connections_removed).toBe(2);
    expect(body.message).toContain("AI app's connector settings");

    expect((await rpc(first.accessToken, "tools/list")).status).toBe(401);
    expect((await rpc(second.accessToken, "tools/list")).status).toBe(401);
    expect((await refreshRequest(second)).status).toBe(400);
    expect((await rpc(other.accessToken, "tools/list")).status).toBe(200);
  });

  it("says how many were removed, and what to do, when it fails midway", async () => {
    const user = await connect(3600, "ops-disconnect-partial");
    await connect(3600, "ops-disconnect-partial");
    const revoke = env.OAUTH_PROVIDER.revokeGrant.bind(env.OAUTH_PROVIDER);
    let revoked = 0;
    vi.spyOn(env.OAUTH_PROVIDER, "revokeGrant").mockImplementation(async (...args) => {
      if (revoked++ === 1) throw new Error("KV is down");
      return revoke(...args);
    });

    const result = (await message(await call(user.accessToken, "disconnect"))).result;

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]?.text ?? "") as { disconnected: boolean; connections_removed: number; message: string };
    expect(body.disconnected).toBe(false);
    expect(body.connections_removed).toBe(1);
    expect(body.message).toMatch(/some or none/);
    expect(body.message).toContain("Try again");
    expect(body.message).toContain("AI app's connector settings");
    expect(JSON.stringify(body)).not.toContain("KV is down");
  });
});

describe("sign-in lifetime", () => {
  it("lasts 90 days from sign-in", async () => {
    await connect(3600, "ops-lifetime");
    const userId = await hmacHex(env.HASH_KEY, "garmin:ops-lifetime");

    const { items } = await env.OAUTH_PROVIDER.listUserGrants(userId);

    expect(items).toHaveLength(1);
    const left = (items[0]?.expiresAt ?? 0) - Math.floor(Date.now() / 1000);
    expect(left).toBeLessThanOrEqual(90 * 24 * 3600);
    expect(left).toBeGreaterThan(90 * 24 * 3600 - 60);
  });
});

describe("user id in props", () => {
  const garmin = { access: "fake-access", refresh: "fake-refresh", clientId: "FAKE_CLIENT", expiresAt: 4_000_000_000 };
  const timeZone = "Europe/London";
  const refresh = (props: object) =>
    tokenExchangeCallback({ grantType: "refresh_token", props, userId: "user-1", grantId: "g", clientId: "c" } as Parameters<typeof tokenExchangeCallback>[0]);

  it("is added to a grant made before props held it, on its first refresh", async () => {
    expect(await refresh({ garmin, displayName: "fake-display-name", timeZone })).toEqual({ newProps: { garmin, displayName: "fake-display-name", timeZone, userId: "user-1" } });
  });

  it("leaves a grant that already has it alone", async () => {
    expect(await refresh({ garmin, displayName: "fake-display-name", timeZone, userId: "user-1" })).toBeUndefined();
  });
});

describe("tool rate limit", () => {
  it("blocks the 61st call in a minute, only for that user", async () => {
    // A counter stands in for the binding, whose real one-minute window could end between two calls.
    const counts = new Map<string, number>();
    vi.spyOn(env.TOOL_LIMIT, "limit").mockImplementation(async ({ key }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= 60 };
    });

    const user = await connect(3600, "ops-limit-a");
    const bystander = await connect(3600, "ops-limit-b");
    const badDate = { date: "not-a-date" };

    for (let i = 1; i <= 60; i++) {
      const result = (await message(await call(user.accessToken, "daily_overview", badDate))).result;
      expect(result.content[0]?.text, `call ${i}`).toMatch(/Invalid input/);
    }
    const blocked = (await message(await call(user.accessToken, "daily_overview", badDate))).result;
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]?.text).toMatch(/Too many requests/);

    const fine = (await message(await call(bystander.accessToken, "daily_overview", badDate))).result;
    expect(fine.content[0]?.text).toMatch(/Invalid input/);
  });

  it("lets the call through when the limiter itself fails, and still records it", async () => {
    const { accessToken } = await connect(3600, "ops-limit-broken");
    vi.spyOn(env.TOOL_LIMIT, "limit").mockRejectedValue(new Error("limiter unavailable"));
    const write = vi.spyOn(env.PONS_EVENTS, "writeDataPoint");
    mockFetch(on("https://connectapi.garmin.com/", () => json({ totalSteps: 7 })));

    const result = (await message(await call(accessToken, "daily_overview", {}))).result;

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("7");
    const tool = write.mock.calls.map(([p]) => p!).find((p) => p.blobs?.[0] === "tool");
    expect(tool?.blobs?.slice(0, 3)).toEqual(["tool", "daily_overview", "ok"]);
  });
});

describe("analytics", () => {
  const FORBIDDEN = [
    "fake-display-name",
    "Test Person",
    "@example.com",
    "fake-garmin-access",
    "fake-refresh",
    "fake-password",
    "ops-analytics-guid",
    "12345", // a step count from the fake Garmin response
    "Bearer",
  ];

  it("records tool calls and initialize with names and timings only", async () => {
    const { accessToken } = await connect(3600, "ops-analytics-guid");
    const write = vi.spyOn(env.PONS_EVENTS, "writeDataPoint");

    await rpc(accessToken, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "9.9" },
    });
    mockFetch(on("https://connectapi.garmin.com/", () => json({ totalSteps: 12345 })));
    await message(await call(accessToken, "daily_overview", {})); // read the reply: the tool runs while it streams
    const points = write.mock.calls.map(([p]) => p!);

    const init = points.find((p) => p.blobs?.[0] === "initialize");
    expect(init?.blobs).toEqual(["initialize", "test-client", "9.9", "other"]);
    const tool = points.find((p) => p.blobs?.[0] === "tool");
    expect(tool?.blobs?.slice(0, 2)).toEqual(["tool", "daily_overview"]);
    expect(tool?.blobs).toHaveLength(4);
    expect(tool?.doubles).toHaveLength(1);

    // The user code is a 64-character hash, the same in the index, and not the Garmin id.
    const userId = String(tool?.indexes?.[0]);
    expect(userId).toMatch(/^[0-9a-f]{64}$/);
    expect(init?.indexes).toEqual([userId]);

    const everything = JSON.stringify(points);
    for (const text of FORBIDDEN) expect(everything, text).not.toContain(text);
  });

  it("skips the initialize event when the body has no Content-Length", async () => {
    const { accessToken } = await connect(3600, "ops-analytics-chunked");
    const write = vi.spyOn(env.PONS_EVENTS, "writeDataPoint");
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chunked-client", version: "1" } },
    });
    const res = await send("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${accessToken}` },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);

    expect(res.status).toBe(200);
    expect((await message(res)).result).toBeDefined();
    expect(write.mock.calls.some(([p]) => p?.blobs?.[0] === "initialize")).toBe(false);
  });

  it("records sign-in outcomes and nothing else", async () => {
    const write = vi.spyOn(env.PONS_EVENTS, "writeDataPoint");
    const { path, handle, cookie } = await openLoginPage();
    mockFetch(
      on(SITEVERIFY, () => json({ success: true })),
      on("https://sso.garmin.com/", () => json({ responseStatus: { type: "INVALID_USERNAME_PASSWORD" } })),
    );
    await post(path, cookie, { handle, email: "ops-analytics@example.com", password: "fake-password", "cf-turnstile-response": "ok" }, { "CF-Connecting-IP": "198.51.100.77" });

    const points = write.mock.calls.map(([p]) => p!);
    expect(points).toEqual([{ indexes: [""], blobs: ["login", "bad_credentials", "", "other"], doubles: [0] }]);
    const everything = JSON.stringify(points);
    for (const text of ["ops-analytics@example.com", "fake-password", "198.51.100.77"]) expect(everything, text).not.toContain(text);
  });

  it("builds a data point from an event without extra fields", () => {
    expect(dataPoint({ type: "tool", name: "x".repeat(300), detail: "ok", ms: 12, platform: "web", userId: "u" })).toEqual({
      indexes: ["u"],
      blobs: ["tool", "x".repeat(100), "ok", "web"],
      doubles: [12],
    });
  });

  it("guesses the platform from the User-Agent", () => {
    expect(platformOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("mobile");
    expect(platformOf("Mozilla/5.0 Claude/1.0 Chrome/120 Electron/28")).toBe("desktop");
    expect(platformOf("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36")).toBe("web");
    expect(platformOf("python-httpx/0.27")).toBe("other");
    expect(platformOf(null)).toBe("other");
  });

  it("reads the client name from an initialize message only", () => {
    expect(initializeInfo({ jsonrpc: "2.0", method: "initialize", params: { clientInfo: { name: "c", version: "1" } } })).toEqual({ name: "c", version: "1" });
    expect(initializeInfo([{ method: "tools/list" }, { method: "initialize", params: {} }])).toEqual({ name: "unknown", version: "" });
    expect(initializeInfo({ method: "tools/call", params: { clientInfo: { name: "c" } } })).toBeUndefined();
    expect(initializeInfo("nonsense")).toBeUndefined();
  });
});

describe("/privacy", () => {
  it("serves the privacy page with the landing page's own script and styles only", async () => {
    const res = await send("/privacy");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Pons privacy");
    expect(html).toContain("not affiliated with Garmin, Anthropic, OpenAI or Google");
    expect(html).toContain("never stores");
    expect(html.match(/<script[^>]*>/g)).toEqual(['<script src="/head.js">']);
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">');
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self';");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("has no source link, and points to whoever shared Pons, while SOURCE_URL is empty", async () => {
    const html = await (await send("/privacy")).text();
    expect(html).toContain("contact the person who shared Pons with you");
    expect(html).not.toContain("open source");
    expect(html).not.toContain("github.com");
    expect(html).not.toContain("<a href=\"http");
  });

  it("links the code and its issues when SOURCE_URL is set", async () => {
    const html = await privacyPage("https://git.example.test/someone/pons/", "en").text();
    expect(html).toContain("It is open source");
    expect(html).toContain('<a href="https://git.example.test/someone/pons" rel="noopener">read the code</a>');
    expect(html).toContain('open an issue at <a href="https://git.example.test/someone/pons/issues"');
    expect(html).not.toContain("contact the person who shared");
  });

  it("is linked from the login page", async () => {
    const { html } = await openLoginPage();
    expect(html).toContain('href="/privacy"');
  });

  it("keeps answering 404 elsewhere", async () => {
    expect((await send("/nothing-here")).status).toBe(404);
    expect((await send("/privacy", { method: "POST" })).status).toBe(404);
  });
});
