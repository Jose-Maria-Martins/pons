import { afterEach, describe, expect, it, vi } from "vitest";
import { garminLogin, garminVerifyMfa } from "../src/login/garmin.js";
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
    expect(await garminLogin("someone@example.com", "fake-password")).toEqual({
      ok: false,
      reason: "mfa_required",
      pending: { cookies: "", method: "email" },
    });
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

describe("2FA", () => {
  const VERIFY = "https://sso.garmin.com/mobile/api/mfa/verifyCode";
  const pending = { cookies: "SESSION=abc; TGC=def", method: "email" };
  const ok = [
    on(DI, () => json({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 7200 })),
    on(PROFILE, () => json({ displayName: "fake-display-name", garminGUID: "fake-guid" })),
  ];

  it("keeps the SSO session cookies and the code method when Garmin asks for a code", async () => {
    mockFetch(
      on(SSO, () => {
        const res = json({ responseStatus: { type: "MFA_REQUIRED" }, customerMfaInfo: { mfaLastMethodUsed: "sms" } });
        res.headers.append("Set-Cookie", "SESSION=abc; Path=/; Secure; HttpOnly");
        res.headers.append("Set-Cookie", "TGC=def; Path=/");
        return res;
      }),
    );
    expect(await garminLogin("someone@example.com", "fake-password")).toEqual({
      ok: false,
      reason: "mfa_required",
      pending: { cookies: "SESSION=abc; TGC=def", method: "sms" },
    });
  });

  it("sends the code with the session cookies, then finishes the login", async () => {
    const { spy } = mockFetch(
      on(VERIFY, () => json({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-fake-2" })),
      ...ok,
    );

    const result = await garminVerifyMfa(pending, "123456");

    expect(result).toMatchObject({ ok: true, garminId: "fake-guid", auth: { access: "fake-access", refresh: "fake-refresh" } });
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toContain("/mobile/api/mfa/verifyCode");
    expect((init?.headers as Record<string, string>).Cookie).toBe("SESSION=abc; TGC=def");
    expect(JSON.parse(String(init?.body))).toMatchObject({ mfaMethod: "email", mfaVerificationCode: "123456" });
  });

  it("reports a wrong code without going further", async () => {
    const { calls } = mockFetch(on(VERIFY, () => json({ responseStatus: { type: "INVALID_VERIFICATION_CODE" } })), ...ok);
    expect(await garminVerifyMfa(pending, "000000")).toEqual({ ok: false, reason: "bad_code" });
    expect(calls).toHaveLength(1);
  });

  it("reports Garmin rate limiting, in the status or in the body", async () => {
    mockFetch(on(VERIFY, () => json({}, 429)));
    expect(await garminVerifyMfa(pending, "123456")).toEqual({ ok: false, reason: "rate_limited" });

    vi.restoreAllMocks();
    mockFetch(on(VERIFY, () => json({ error: { "status-code": "429" } })));
    expect(await garminVerifyMfa(pending, "123456")).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("treats a reply that is not JSON, or a network error, as Garmin being unavailable", async () => {
    mockFetch(on(VERIFY, () => new Response("<html>blocked</html>", { status: 403 })));
    expect(await garminVerifyMfa(pending, "123456")).toEqual({ ok: false, reason: "unavailable" });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect(await garminVerifyMfa(pending, "123456")).toEqual({ ok: false, reason: "unavailable" });
  });
});
