import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMfaState, mfaFingerprint, newMfaExpiry, newMfaHandle, saveMfaState, type MfaState } from "../src/login/mfa.js";
import { json, mockFetch, on, openLoginPage, post, REDIRECT } from "./helpers.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SSO = "https://sso.garmin.com/mobile/api/login";
const VERIFY = "https://sso.garmin.com/mobile/api/mfa/verifyCode";
const SSO_COOKIE_VALUE = "sso-session-secret-value";

afterEach(() => vi.restoreAllMocks());

let people = 0;

/** A visitor with their own address and email, so the rate limits of other tests do not apply. */
function visitor() {
  const n = ++people;
  return { email: `mfa-person${n}@example.com`, ip: `198.18.0.${n}` };
}

const mfaKeys = async () => (await env.OAUTH_KV.list({ prefix: "mfa:" })).keys.map((k) => k.name);

const loginHeaders = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith("__Host-pons_mfa=")) ?? "";

/** Sign in with a password until Garmin asks for the 2FA code. */
async function reachCodePage(who = visitor()) {
  const { path, handle, cookie } = await openLoginPage();
  const before = await mfaKeys();
  const logged = mockFetch(
    on(SITEVERIFY, () => json({ success: true })),
    on(SSO, () => {
      const res = json({ responseStatus: { type: "MFA_REQUIRED" }, customerMfaInfo: { mfaLastMethodUsed: "email" } });
      res.headers.append("Set-Cookie", `SESSION=${SSO_COOKIE_VALUE}; Path=/; Secure; HttpOnly`);
      return res;
    }),
  );
  const res = await post(path, cookie, { handle, email: who.email, password: "fake-password", "cf-turnstile-response": "ok" }, { "CF-Connecting-IP": who.ip });
  vi.restoreAllMocks();
  const setCookie = loginHeaders(res);
  return {
    res,
    html: await res.text(),
    setCookie,
    mfaCookie: setCookie.split(";")[0] ?? "",
    mfaHandle: (setCookie.split(";")[0] ?? "").split("=")[1] ?? "",
    who,
    calls: logged.calls,
    // The KV key of this sign-in. Other tests leave their own entries behind.
    key: (await mfaKeys()).find((k) => !before.includes(k)) ?? "",
  };
}

/** Submit the code form. `tab` is the form's hidden tag; by default the one of the sign-in the cookie belongs to. */
const submitCode = async (mfaCookie: string, code: string, ip: string, token = "ok", tab?: string) =>
  post(
    "/authorize",
    mfaCookie,
    { step: "mfa", code, tab: tab ?? (await mfaFingerprint(mfaCookie.split("=")[1] ?? "")), "cf-turnstile-response": token },
    { "CF-Connecting-IP": ip },
  );

const tabOf = (html: string) => /name="tab" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";

const goodGarmin = () => [
  on(SITEVERIFY, () => json({ success: true })),
  on(VERIFY, () => json({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-fake-2" })),
  on("https://diauth.garmin.com/", () => json({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 })),
  on("https://connectapi.garmin.com/userprofile-service/socialProfile", () => json({ displayName: "fake-display-name", garminGUID: "fake-guid" })),
];

const wrongCode = () => [
  on(SITEVERIFY, () => json({ success: true })),
  on(VERIFY, () => json({ responseStatus: { type: "INVALID_VERIFICATION_CODE" } })),
];

describe("the 2FA code page", () => {
  it("replaces the password form when Garmin asks for a code, and binds the step to the browser", async () => {
    const { res, html, setCookie, mfaHandle } = await reachCodePage();

    expect(res.status).toBe(200);
    expect(html).toContain("verification code");
    expect(html).toContain('name="code"');
    expect(html).toContain(`name="tab" value="${await mfaFingerprint(mfaHandle)}"`);
    expect(html).not.toContain(mfaHandle);
    expect(html).toContain('data-sitekey="1x00000000000000000000AA"');
    expect(html).not.toContain('name="password"');
    expect(setCookie).toMatch(/^__Host-pons_mfa=[A-Za-z0-9_-]{40,};/);
    for (const attribute of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=600"]) expect(setCookie).toContain(attribute);
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("keeps only ciphertext in KV, for about ten minutes", async () => {
    const before = await mfaKeys();
    const { mfaHandle } = await reachCodePage();

    const created = (await mfaKeys()).filter((k) => !before.includes(k));
    expect(created).toHaveLength(1);
    const key = created[0]!;
    expect(key).toMatch(/^mfa:[0-9a-f]{64}$/);
    expect(key).not.toContain(mfaHandle);

    const stored = (await env.OAUTH_KV.get(key))!;
    expect(stored).toMatch(/^[A-Za-z0-9+/]+=*$/);
    for (const secret of [SSO_COOKIE_VALUE, mfaHandle, "client.example", "state-123", "email", "code_challenge"]) {
      expect(stored).not.toContain(secret);
      // Also not in the base64 of the plain text.
      expect(stored).not.toContain(btoa(secret).replace(/=+$/, ""));
    }

    const { keys } = await env.OAUTH_KV.list({ prefix: key });
    const expiration = keys[0]!.expiration!;
    const secondsLeft = expiration - Math.floor(Date.now() / 1000);
    expect(secondsLeft).toBeGreaterThan(540);
    expect(secondsLeft).toBeLessThanOrEqual(600);
  });
});

describe("submitting the 2FA code", () => {
  it("finishes the sign-in: sends the code and cookies to Garmin, redirects with a code, then forgets everything", async () => {
    const { mfaCookie, mfaHandle, who, key } = await reachCodePage();
    const logs = vi.spyOn(console, "log");
    const { spy } = mockFetch(...goodGarmin());

    const res = await submitCode(mfaCookie, "123 456", who.ip);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(res.headers.getSetCookie().join("\n")).toMatch(/__Host-pons_mfa=; Max-Age=0/);

    const verify = spy.mock.calls.find(([url]) => String(url).includes("/mfa/verifyCode"))!;
    expect((verify[1]?.headers as Record<string, string>).Cookie).toBe(`SESSION=${SSO_COOKIE_VALUE}`);
    expect(JSON.parse(String(verify[1]?.body))).toMatchObject({ mfaVerificationCode: "123456", mfaMethod: "email" });

    expect(await env.OAUTH_KV.get(key)).toBeNull();
    const logged = JSON.stringify(logs.mock.calls);
    expect(logged).toContain("mfa_ok");
    for (const secret of ["123456", SSO_COOKIE_VALUE, mfaHandle, "fake-access", "fake-refresh"]) expect(logged).not.toContain(secret);

    // The page cannot be used a second time.
    vi.restoreAllMocks();
    const { calls } = mockFetch(...goodGarmin());
    const replay = await submitCode(mfaCookie, "123456", who.ip);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("expired");
    expect(calls.filter((c) => c.includes("garmin.com"))).toEqual([]);
  });

  it("counts down three tries, then ends the sign-in", async () => {
    const { mfaCookie, who, key } = await reachCodePage();
    mockFetch(...wrongCode());

    const first = await submitCode(mfaCookie, "000001", who.ip);
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain("You have 2 tries left");
    expect(firstHtml).toContain(`name="tab" value="${await mfaFingerprint(mfaCookie.split("=")[1] ?? "")}"`);
    expect(await submitCode(mfaCookie, "000002", who.ip).then((r) => r.text())).toContain("You have 1 try left");

    const third = await submitCode(mfaCookie, "000003", who.ip);
    expect(third.status).toBe(400);
    expect(await third.text()).toContain("three times");
    expect(await env.OAUTH_KV.get(key)).toBeNull();

    // Even the right code is no use now.
    vi.restoreAllMocks();
    const { calls } = mockFetch(...goodGarmin());
    const late = await submitCode(mfaCookie, "123456", who.ip);
    expect(late.status).toBe(400);
    expect(calls.filter((c) => c.includes("garmin.com"))).toEqual([]);
  });

  it("shows the tries left in Portuguese when the language cookie says so", async () => {
    const { mfaCookie, mfaHandle, who } = await reachCodePage();
    mockFetch(...wrongCode());

    const res = await submitCode(`${mfaCookie}; __Host-pons_lang=pt`, "000001", who.ip, "ok", await mfaFingerprint(mfaHandle));

    const html = await res.text();
    expect(html).toContain('<html lang="pt-PT">');
    expect(html).toContain("Restam-lhe 2 tentativas.");
    expect(html).not.toContain("tries left");
  });

  it("saves the try before asking Garmin, so a parallel submission already sees it", async () => {
    const { mfaCookie, mfaHandle, who } = await reachCodePage();
    let seenByGarmin: number | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(SITEVERIFY)) return json({ success: true });
      if (url.startsWith(VERIFY)) {
        seenByGarmin = (await loadMfaState(env, mfaHandle))?.attempts;
        return json({ responseStatus: { type: "INVALID_VERIFICATION_CODE" } });
      }
      throw new Error("Unexpected fetch to " + url);
    });

    const res = await submitCode(mfaCookie, "000001", who.ip);

    expect(seenByGarmin).toBe(1);
    expect(await res.text()).toContain("You have 2 tries left");
  });

  it("ends the sign-in without contacting Garmin when the tries were already used up", async () => {
    const { mfaCookie, mfaHandle, who, key } = await reachCodePage();
    await saveMfaState(env, mfaHandle, { ...(await loadMfaState(env, mfaHandle))!, attempts: 3 });
    const { calls } = mockFetch(...goodGarmin());

    const res = await submitCode(mfaCookie, "123456", who.ip);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("three times");
    expect(await env.OAUTH_KV.get(key)).toBeNull();
    expect(calls.filter((c) => c.includes("garmin.com"))).toEqual([]);
  });

  it("tells an older tab its sign-in was replaced, and leaves the newer sign-in alone", async () => {
    const older = await reachCodePage();
    const newer = await reachCodePage();
    expect(tabOf(older.html)).not.toBe(tabOf(newer.html));
    const { calls } = mockFetch(...goodGarmin());

    // The browser holds the newer cookie, but this form came from the older sign-in.
    const res = await submitCode(newer.mfaCookie, "123456", newer.who.ip, "ok", tabOf(older.html));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("replaced by a newer one");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(calls.filter((c) => c.includes("garmin.com"))).toEqual([]);
    expect((await loadMfaState(env, newer.mfaHandle))?.attempts).toBe(0);

    // The newer form still works.
    vi.restoreAllMocks();
    mockFetch(...goodGarmin());
    expect((await submitCode(newer.mfaCookie, "123456", newer.who.ip, "ok", tabOf(newer.html))).status).toBe(302);
  });

  it("accepts the right code after a wrong one", async () => {
    const { mfaCookie, who } = await reachCodePage();
    mockFetch(...wrongCode());
    expect(await submitCode(mfaCookie, "000001", who.ip).then((r) => r.text())).toContain("2 tries left");

    vi.restoreAllMocks();
    mockFetch(...goodGarmin());
    expect((await submitCode(mfaCookie, "123456", who.ip)).status).toBe(302);
  });

  it("shows a plain page without contacting Garmin when the cookie is missing, unknown or expired", async () => {
    const { mfaCookie, mfaHandle, who, key } = await reachCodePage();
    const { calls } = mockFetch(...goodGarmin());

    const none = await submitCode("", "123456", who.ip);
    expect(none.status).toBe(400);
    expect(await none.text()).toContain("Go back to Claude");

    const unknown = await submitCode("__Host-pons_mfa=" + newMfaHandle(), "123456", who.ip);
    expect(unknown.status).toBe(400);

    // Expire the saved entry by removing it, like KV does after its time to live.
    await env.OAUTH_KV.delete(key);
    const expired = await submitCode(mfaCookie, "123456", who.ip);
    expect(expired.status).toBe(400);
    expect(expired.headers.getSetCookie().join("\n")).toContain("__Host-pons_mfa=; Max-Age=0");
    expect(mfaHandle).not.toBe("");
    expect(calls.filter((c) => c.includes("garmin.com"))).toEqual([]);
  });

  it("checks Turnstile again, and a failed check does not use up a try or reach Garmin", async () => {
    const { mfaCookie, who } = await reachCodePage();
    const { calls } = mockFetch(on(SITEVERIFY, () => json({ success: false })));

    const res = await submitCode(mfaCookie, "123456", who.ip, "bad-token");

    expect(await res.text()).toContain("confirm you&#39;re a person");
    expect(calls.filter((c) => c.includes("garmin.com"))).toEqual([]);

    vi.restoreAllMocks();
    mockFetch(...wrongCode());
    expect(await submitCode(mfaCookie, "000001", who.ip).then((r) => r.text())).toContain("2 tries left");
  });

  it("asks again for a code that is not digits, without contacting Garmin", async () => {
    const { mfaCookie, who } = await reachCodePage();
    const { calls } = mockFetch(...goodGarmin());
    const res = await submitCode(mfaCookie, "abc", who.ip);
    expect(await res.text()).toContain("Enter the code Garmin sent you");
    expect(calls).toEqual([]);
  });

  it("does not use up a try when Garmin cannot be reached", async () => {
    const { mfaCookie, mfaHandle, who, key } = await reachCodePage();
    mockFetch(on(SITEVERIFY, () => json({ success: true })), on(VERIFY, () => new Response("<html>down</html>", { status: 502 })));
    const res = await submitCode(mfaCookie, "123456", who.ip);
    expect(await res.text()).toContain("Couldn&#39;t reach Garmin");
    expect(await env.OAUTH_KV.get(key)).not.toBeNull();
    expect((await loadMfaState(env, mfaHandle))?.attempts).toBe(0);
  });

  it("limits code tries from one address before contacting Garmin", async () => {
    const ip = visitor().ip;
    // Five tries per address per minute: two sign-ins (2) and then codes (4), the last one is stopped.
    const first = await reachCodePage({ email: visitor().email, ip });
    const second = await reachCodePage({ email: visitor().email, ip });
    const { calls } = mockFetch(...wrongCode());
    const texts: string[] = [];
    for (const [cookie, count] of [[first.mfaCookie, 2], [second.mfaCookie, 2]] as const) {
      for (let i = 0; i < count; i++) texts.push(await submitCode(cookie, "000000", ip).then((r) => r.text()));
    }
    expect(texts.slice(0, 3).some((t) => t.includes("Too many tries"))).toBe(false);
    expect(texts[3]).toContain("Too many tries");
    expect(calls.filter((c) => c.includes("/mfa/verifyCode"))).toHaveLength(3);
  });
});

describe("the saved 2FA state", () => {
  const state = (): MfaState => ({
    cookies: "SESSION=value",
    method: "email",
    request: { responseType: "code", clientId: "c", redirectUri: REDIRECT, scope: [], state: "s" },
    emailKey: "email:abc",
    attempts: 0,
    expiresAt: newMfaExpiry(),
  });

  it("round-trips", async () => {
    const handle = newMfaHandle();
    await saveMfaState(env, handle, state());
    expect(await loadMfaState(env, handle)).toMatchObject({ cookies: "SESSION=value", attempts: 0 });
  });

  it("cannot be read with another handle or another HASH_KEY", async () => {
    const handle = newMfaHandle();
    await saveMfaState(env, handle, state());
    expect(await loadMfaState(env, newMfaHandle())).toBeNull();
    expect(await loadMfaState({ ...env, HASH_KEY: "another-key" } as Env, handle)).toBeNull();
  });

  it("is ignored once its time is up", async () => {
    const handle = newMfaHandle();
    await saveMfaState(env, handle, { ...state(), expiresAt: Math.floor(Date.now() / 1000) - 1 });
    expect(await loadMfaState(env, handle)).toBeNull();
  });
});
