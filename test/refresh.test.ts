import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenExchangeCallback } from "../src/index.js";
import { refreshGarminAuth } from "../src/login/garmin.js";
import { connect, json, message, mockFetch, on, refreshed, refreshRequest, rpc } from "./helpers.js";

const DI = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const API = "https://connectapi.garmin.com";
const THREE_HOURS = 3 * 3600;
const SETTINGS = `${API}/userprofile-service/userprofile/settings`;

afterEach(() => vi.restoreAllMocks());

/** The form fields Garmin received in a recorded DI request. */
const diBody = (init?: RequestInit) => Object.fromEntries(new URLSearchParams(String(init?.body)));

/** Call connection_status and report which Garmin token the tool used. */
async function garminTokenUsedBy(accessToken: string): Promise<string | undefined> {
  const { spy } = mockFetch(
    on(`${API}/userprofile-service/socialProfile`, () => json({ fullName: "Test Person" })),
    on(`${API}/userprofile-service/userprofile/user-settings`, () => json({})),
    on(`${API}/wellness-service/wellness/syncTimestamp`, () => json(null)),
  );
  const result = (await message(await rpc(accessToken, "tools/call", { name: "connection_status", arguments: {} }))).result;
  expect(result.isError).toBeFalsy();
  const headers = spy.mock.calls[0]![1]?.headers as Record<string, string>;
  vi.restoreAllMocks();
  return headers.Authorization;
}

describe("Garmin token refresh when Claude refreshes its Pons token", () => {
  it("refreshes a Garmin token with under 3 h left, and tools then use the new one", async () => {
    const session = await connect(3600);
    const { spy } = mockFetch(on(DI, () => json({ access_token: "new-garmin-access", refresh_token: "new-garmin-refresh", expires_in: 90_000 })));

    const next = await refreshed(session);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe(DI);
    expect(diBody(init)).toEqual({
      grant_type: "refresh_token",
      client_id: "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2",
      refresh_token: "fake-refresh",
    });
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Basic " + btoa("GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2:"));
    expect(headers["User-Agent"]).toBe("GCM-Android-5.23");
    vi.restoreAllMocks();

    expect(await garminTokenUsedBy(next.accessToken)).toBe("Bearer new-garmin-access");
  });

  it("keeps the rotated Garmin refresh token, and the old one when Garmin sends none", async () => {
    const first = await connect(3600);
    // Every refresh leaves under 3 h on the Garmin token, so each Pons refresh asks Garmin again.
    mockFetch(on(DI, () => json({ access_token: "garmin-access-2", refresh_token: "garmin-refresh-2", expires_in: 3600 })));
    const second = await refreshed(first);
    vi.restoreAllMocks();

    const noRotation = mockFetch(on(DI, () => json({ access_token: "garmin-access-3", expires_in: 3600 })));
    const third = await refreshed(second);
    vi.restoreAllMocks();

    const again = mockFetch(on(DI, () => json({ access_token: "garmin-access-4", expires_in: 3600 })));
    await refreshed(third);

    // The second refresh used the rotated token. Garmin sent no new one, so the third kept using it.
    expect(diBody(noRotation.spy.mock.calls[0]![1]).refresh_token).toBe("garmin-refresh-2");
    expect(diBody(again.spy.mock.calls[0]![1]).refresh_token).toBe("garmin-refresh-2");
  });

  it("does not contact Garmin when more than 3 h are left", async () => {
    const session = await connect(THREE_HOURS + 600);
    const { calls } = mockFetch();

    const next = await refreshed(session);

    expect(calls).toEqual([]);
    vi.restoreAllMocks();
    expect(await garminTokenUsedBy(next.accessToken)).toBe("Bearer fake-garmin-access");
  });

  it("refreshes when the Garmin token has already expired", async () => {
    const session = await connect(-60);
    mockFetch(on(DI, () => json({ access_token: "new-garmin-access", expires_in: 90_000 })));
    const next = await refreshed(session);
    vi.restoreAllMocks();
    expect(await garminTokenUsedBy(next.accessToken)).toBe("Bearer new-garmin-access");
  });

  it("revokes the grant when Garmin refuses the refresh token (401)", async () => {
    const session = await connect(3600);
    mockFetch(on(DI, () => json({ error: "invalid_grant" }, 401)));

    const res = await refreshRequest(session);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    // The grant is gone: the same refresh token no longer works, and Garmin is not asked again.
    vi.restoreAllMocks();
    const { calls } = mockFetch();
    const again = await refreshRequest(session);
    expect(((await again.json()) as { error: string }).error).toBe("invalid_grant");
    expect(calls).toEqual([]);
  });

  it("revokes the grant when Garmin answers 400", async () => {
    const session = await connect(3600);
    mockFetch(on(DI, () => json({}, 400)));
    const res = await refreshRequest(session);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("keeps the grant when Garmin has a 5xx, so the client can try again", async () => {
    const session = await connect(3600);
    mockFetch(on(DI, () => json({}, 503)));

    const res = await refreshRequest(session);

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("temporarily_unavailable");
    expect(res.headers.get("Retry-After")).toBe("60");

    vi.restoreAllMocks();
    mockFetch(on(DI, () => json({ access_token: "new-garmin-access", expires_in: 90_000 })));
    const next = await refreshed(session);
    vi.restoreAllMocks();
    expect(await garminTokenUsedBy(next.accessToken)).toBe("Bearer new-garmin-access");
  });

  it("keeps the grant when Garmin rate-limits the refresh (429)", async () => {
    const session = await connect(3600);
    mockFetch(on(DI, () => json({}, 429)));
    const res = await refreshRequest(session);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("temporarily_unavailable");
  });

  it("keeps the grant when Garmin cannot be reached", async () => {
    const session = await connect(3600);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const res = await refreshRequest(session);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("temporarily_unavailable");
  });
});

describe("refreshGarminAuth", () => {
  const auth = { access: "old-access", refresh: "old-refresh", clientId: "FAKE_CLIENT", expiresAt: 1 };
  const jwt = (claims: object) => `${btoa("{}")}.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.sig`;

  it("uses the app id Garmin put in the new token", async () => {
    mockFetch(on(DI, () => json({ access_token: jwt({ client_id: "ID_FROM_TOKEN" }), expires_in: 100 })));
    const result = await refreshGarminAuth(auth);
    expect(result).toMatchObject({ ok: true, auth: { clientId: "ID_FROM_TOKEN", refresh: "old-refresh" } });
  });

  it("falls back to the stored app id when the token is not a JWT", async () => {
    mockFetch(on(DI, () => json({ access_token: "opaque", expires_in: 100 })));
    expect(await refreshGarminAuth(auth)).toMatchObject({ ok: true, auth: { clientId: "FAKE_CLIENT" } });
  });

  it("cannot refresh without a refresh token", async () => {
    const { calls } = mockFetch();
    expect(await refreshGarminAuth({ ...auth, refresh: "" })).toEqual({ ok: false, reason: "rejected" });
    expect(calls).toEqual([]);
  });

  it("treats an answer without a token as unavailable", async () => {
    mockFetch(on(DI, () => json({ expires_in: 100 })));
    expect(await refreshGarminAuth(auth)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("refreshGarminAuth expiry", () => {
  const auth = { access: "old-access", refresh: "old-refresh", clientId: "FAKE_CLIENT", expiresAt: 1 };
  const jwt = (claims: object) => `${btoa("{}")}.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.sig`;

  it("takes the new expiry from the token's exp, not from expires_in", async () => {
    const exp = Math.floor(Date.now() / 1000) + 86_400;
    mockFetch(on(DI, () => json({ access_token: jwt({ exp }), expires_in: 60 })));
    expect(await refreshGarminAuth(auth)).toMatchObject({ ok: true, auth: { expiresAt: exp } });
  });

  it("accepts expires_in as a numeric string, and falls back to an hour", async () => {
    const before = Math.floor(Date.now() / 1000);
    mockFetch(on(DI, () => json({ access_token: "opaque", expires_in: "7200" })));
    const withString = await refreshGarminAuth(auth);
    vi.restoreAllMocks();
    mockFetch(on(DI, () => json({ access_token: "opaque", expires_in: "garbage" })));
    const withGarbage = await refreshGarminAuth(auth);
    expect(withString.ok && withString.auth.expiresAt).toBeGreaterThanOrEqual(before + 7200);
    expect(withString.ok && withString.auth.expiresAt).toBeLessThan(before + 7200 + 5);
    expect(withGarbage.ok && withGarbage.auth.expiresAt).toBeGreaterThanOrEqual(before + 3600);
    expect(withGarbage.ok && withGarbage.auth.expiresAt).toBeLessThan(before + 3600 + 5);
  });
});

describe("tokenExchangeCallback", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const garmin = (expiresAt: number) => ({ access: "fake-access", refresh: "fake-refresh", clientId: "FAKE_CLIENT", expiresAt });
  const props = (expiresAt: number, extra: object = {}) => ({ garmin: garmin(expiresAt), displayName: "fake-display-name", userId: "user-1", timeZone: "UTC", ...extra });
  const run = (grantType: "authorization_code" | "refresh_token", p: object) =>
    tokenExchangeCallback({ grantType, props: p, userId: "user-1", grantId: "g", clientId: "c" } as Parameters<typeof tokenExchangeCallback>[0]);
  const ttlOf = (result: unknown) => (result as { accessTokenTTL?: number } | undefined)?.accessTokenTTL;

  it("backfills a missing time zone with one settings call on a refresh", async () => {
    const { calls } = mockFetch(on(SETTINGS, () => json({ timeZone: "Australia/Sydney" })));
    const stored = props(now() + 90_000, { timeZone: undefined });

    const result = (await run("refresh_token", stored)) as { newProps: { timeZone: string } };

    expect(calls).toEqual([SETTINGS]);
    expect(result.newProps).toMatchObject({ timeZone: "Australia/Sydney", userId: "user-1" });
  });

  it("backfills after a Garmin refresh, with the new Garmin token", async () => {
    const { spy } = mockFetch(
      on(DI, () => json({ access_token: "new-garmin-access", expires_in: 90_000 })),
      on(SETTINGS, () => json({ timeZone: "America/Los_Angeles" })),
    );

    const result = (await run("refresh_token", props(now() + 60, { timeZone: undefined }))) as { newProps: { timeZone: string; garmin: { access: string } } };

    expect(result.newProps.garmin.access).toBe("new-garmin-access");
    expect(result.newProps.timeZone).toBe("America/Los_Angeles");
    const settingsCall = spy.mock.calls.find(([url]) => String(url) === SETTINGS)!;
    expect((settingsCall[1]?.headers as Record<string, string>).Authorization).toBe("Bearer new-garmin-access");
  });

  it("keeps going without a time zone when the settings call fails", async () => {
    mockFetch(on(SETTINGS, () => json({}, 500)));
    expect(await run("refresh_token", props(now() + 90_000, { timeZone: undefined }))).toBeUndefined();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect(await run("refresh_token", props(now() + 90_000, { timeZone: undefined }))).toBeUndefined();
  });

  it("does not ask for the time zone when the grant already has one", async () => {
    const { calls } = mockFetch();
    expect(await run("refresh_token", props(now() + 90_000))).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("caps the Pons access token at what is left of the Garmin token, minus a minute", async () => {
    const { calls } = mockFetch();
    const ttl = ttlOf(await run("authorization_code", props(now() + 1800)));
    expect(ttl).toBeGreaterThanOrEqual(1800 - 60 - 2);
    expect(ttl).toBeLessThanOrEqual(1800 - 60);
    expect(calls).toEqual([]);
  });

  it("never goes under 60 seconds", async () => {
    expect(ttlOf(await run("authorization_code", props(now() + 90)))).toBe(60);
    expect(ttlOf(await run("authorization_code", props(now() - 500)))).toBe(60);
  });

  it("caps the access token of a refresh by the new Garmin token", async () => {
    mockFetch(on(DI, () => json({ access_token: "new-garmin-access", expires_in: 1200 })));
    const ttl = ttlOf(await run("refresh_token", props(now() + 60)));
    expect(ttl).toBeGreaterThanOrEqual(1200 - 60 - 2);
    expect(ttl).toBeLessThanOrEqual(1200 - 60);
  });

  it("sets no TTL when the Garmin token has an hour or more left", async () => {
    expect(await run("authorization_code", props(now() + 3700))).toBeUndefined();
    mockFetch(on(DI, () => json({ access_token: "new-garmin-access", expires_in: 90_000 })));
    const result = await run("refresh_token", props(now() + 60));
    expect(result).toHaveProperty("newProps");
    expect(ttlOf(result)).toBeUndefined();
  });

  it("gives the client a shorter token over HTTP when the Garmin token is about to end", async () => {
    const short = await connect(1800);
    expect(short.expiresIn).toBeLessThanOrEqual(1800 - 60);
    expect(short.expiresIn).toBeGreaterThan(1800 - 60 - 5);
    const long = await connect(90_000);
    expect(long.expiresIn).toBe(3600);

    mockFetch(on(DI, () => json({ access_token: "new-garmin-access", expires_in: 600 })));
    const next = await refreshed(short);
    expect(next.expiresIn).toBeLessThanOrEqual(600 - 60);
    expect(next.expiresIn).toBeGreaterThan(600 - 60 - 5);
  });
});
