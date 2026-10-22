import { afterEach, describe, expect, it, vi } from "vitest";
import { garminLogin } from "../src/login/garmin.js";
import { json, mockFetch, on } from "./helpers.js";

const SSO = "https://sso.garmin.com/mobile/api/login";
const DI = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const PROFILE = "https://connectapi.garmin.com/userprofile-service/socialProfile";

afterEach(() => vi.restoreAllMocks());

describe("garminLogin", () => {
  it("returns the token and profile on SUCCESSFUL", async () => {
    const { calls } = mockFetch(
      on(SSO, () => json({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-fake-1" })),
      on(DI, () => json({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 7200 })),
      on(PROFILE, () => json({ displayName: "fake-display-name", garminGUID: "fake-guid" })),
    );

    const result = await garminLogin("someone@example.com", "fake-password");

    expect(result).toMatchObject({
      ok: true,
      displayName: "fake-display-name",
      garminId: "fake-guid",
      auth: { access: "fake-access", refresh: "fake-refresh", clientId: "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2" },
    });
    expect(calls).toEqual([
      "https://sso.garmin.com/mobile/api/login",
      "https://diauth.garmin.com/di-oauth2-service/oauth/token",
      "https://connectapi.garmin.com/userprofile-service/socialProfile",
    ]);
  });

  it("tries the next client id when Garmin refuses the first", async () => {
    let attempts = 0;
    mockFetch(
      on(SSO, () => json({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-fake-1" })),
      on(DI, () => (++attempts < 2 ? json({}, 401) : json({ access_token: "fake-access" }))),
      on(PROFILE, () => json({ displayName: "fake-display-name", profileId: 12345 })),
    );
    const result = await garminLogin("someone@example.com", "fake-password");
    expect(result).toMatchObject({ ok: true, garminId: "12345", auth: { clientId: "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4" } });
  });

  it("reports MFA_REQUIRED without going further", async () => {
    const { calls } = mockFetch(on(SSO, () => json({ responseStatus: { type: "MFA_REQUIRED" } })));
    expect(await garminLogin("someone@example.com", "fake-password")).toEqual({ ok: false, reason: "mfa_required" });
    expect(calls).toHaveLength(1);
  });

  it("reports INVALID_USERNAME_PASSWORD", async () => {
    mockFetch(on(SSO, () => json({ responseStatus: { type: "INVALID_USERNAME_PASSWORD" } })));
    expect(await garminLogin("someone@example.com", "wrong")).toEqual({ ok: false, reason: "bad_credentials" });
  });

  it("reports a Garmin 429", async () => {
    mockFetch(on(SSO, () => json({}, 429)));
    expect(await garminLogin("someone@example.com", "fake-password")).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("reports Garmin being down, including network errors and odd replies", async () => {
    mockFetch(on(SSO, () => new Response("<html>oops</html>", { status: 502 })));
    expect(await garminLogin("a@example.com", "x")).toEqual({ ok: false, reason: "unavailable" });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect(await garminLogin("a@example.com", "x")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("never sends the password anywhere except the Garmin sign-in call", async () => {
    const { spy } = mockFetch(
      on(SSO, () => json({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-fake-1" })),
      on(DI, () => json({ access_token: "fake-access" })),
      on(PROFILE, () => json({ displayName: "fake-display-name", garminGUID: "fake-guid" })),
    );
    await garminLogin("someone@example.com", "fake-password-xyz");
    const withPassword = spy.mock.calls.filter(([, init]) => String(init?.body ?? "").includes("fake-password-xyz"));
    expect(withPassword).toHaveLength(1);
    expect(String(withPassword[0]![0])).toContain("sso.garmin.com");
  });
});
