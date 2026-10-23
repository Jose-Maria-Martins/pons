import { afterEach, describe, expect, it, vi } from "vitest";
import { json, mockFetch, on, openLoginPage, post, REDIRECT, send } from "./helpers.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

afterEach(() => vi.restoreAllMocks());

describe("GET /authorize", () => {
  it("renders the login page for a registered client, with strict security headers", async () => {
    const { page, html, handle } = await openLoginPage();

    expect(page.status).toBe(200);
    expect(html).toContain("Connect your Garmin");
    expect(html).toContain("Test Client");
    expect(html).toContain("client.example");
    expect(html).toContain('data-sitekey="1x00000000000000000000AA"');
    expect(handle).not.toBe("");

    const csp = page.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("https://challenges.cloudflare.com");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("img-src 'self'");
    expect(html).toContain('<link rel="icon" href="/icon.png">');
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("refuses an unknown client without echoing it back", async () => {
    const res = await send("/authorize?response_type=code&client_id=nope&redirect_uri=https://evil.example/&state=x");
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("evil.example");
  });
});

describe("POST /authorize", () => {
  it("refuses a missing or failed Turnstile check before any Garmin request", async () => {
    const { path, handle, cookie } = await openLoginPage();
    const { calls } = mockFetch(on(SITEVERIFY, () => json({ success: false })));

    for (const token of ["", "bad-token"]) {
      const res = await post(path, cookie, { handle, email: "someone@example.com", password: "fake-password", "cf-turnstile-response": token });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("confirm you&#39;re a person");
    }

    expect(calls.filter((c) => c.includes("garmin.com"))).toEqual([]);
  });

  describe("body size", () => {
    const stream = (text: string, pieces: number) => {
      const size = Math.ceil(text.length / pieces);
      let at = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= text.length) return controller.close();
          controller.enqueue(new TextEncoder().encode(text.slice(at, (at += size))));
        },
      });
    };
    // A stream body has no Content-Length, like a chunked request.
    const postStream = (path: string, cookie: string, text: string) =>
      send(path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
        body: stream(text, 20),
        duplex: "half",
      } as RequestInit);

    it("refuses a body that announces more than the limit", async () => {
      const { path, cookie } = await openLoginPage();
      const { calls } = mockFetch(on(SITEVERIFY, () => json({ success: true })));
      const res = await post(path, cookie, { email: "someone@example.com", password: "x".repeat(20_000) });
      expect(res.status).toBe(413);
      expect(calls).toEqual([]);
    });

    it("refuses a chunked body over the limit, which has no Content-Length", async () => {
      const { path, handle, cookie } = await openLoginPage();
      const { calls } = mockFetch(on(SITEVERIFY, () => json({ success: true })));
      const body = new URLSearchParams({ handle, email: "someone@example.com", password: "x".repeat(20_000) }).toString();
      const res = await postStream(path, cookie, body);
      expect(res.status).toBe(413);
      expect(calls).toEqual([]);
    });

    it("still reads a small chunked body", async () => {
      const { path, handle, cookie } = await openLoginPage();
      mockFetch(
        on(SITEVERIFY, () => json({ success: true })),
        on("https://sso.garmin.com/mobile/api/login", () => json({ responseStatus: { type: "INVALID_USERNAME_PASSWORD" } })),
      );
      const body = new URLSearchParams({ handle, email: "someone@example.com", password: "fake-password", "cf-turnstile-response": "ok" }).toString();
      const res = await postStream(path, cookie, body);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("didn&#39;t accept that email or password");
    });
  });

  it("signs in and sends the user back to the client with an authorization code", async () => {
    const { path, handle, cookie } = await openLoginPage();
    mockFetch(
      on(SITEVERIFY, () => json({ success: true })),
      on("https://sso.garmin.com/mobile/api/login", () => json({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-fake-1" })),
      on("https://diauth.garmin.com/", () => json({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 })),
      on("https://connectapi.garmin.com/userprofile-service/socialProfile", () => json({ displayName: "fake-display-name", garminGUID: "fake-guid" })),
    );

    const res = await post(path, cookie, { handle, email: "someone@example.com", password: "fake-password", "cf-turnstile-response": "ok-token" });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("state-123");
  });

  it("shows a plain message and a fresh form when Garmin rejects the password", async () => {
    const { path, handle, cookie } = await openLoginPage();
    mockFetch(
      on(SITEVERIFY, () => json({ success: true })),
      on("https://sso.garmin.com/", () => json({ responseStatus: { type: "INVALID_USERNAME_PASSWORD" } })),
    );
    const res = await post(path, cookie, { handle, email: "someone@example.com", password: "wrong", "cf-turnstile-response": "ok-token" });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("didn&#39;t accept that email or password");
    expect(html).not.toContain("wrong");
    expect(/name="handle" value="([^"]+)"/.exec(html)?.[1]).not.toBe(handle);
  });

  it("limits repeated tries from one address before contacting Garmin", async () => {
    const { calls } = mockFetch(
      on(SITEVERIFY, () => json({ success: true })),
      on("https://sso.garmin.com/", () => json({ responseStatus: { type: "INVALID_USERNAME_PASSWORD" } })),
    );
    const texts: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { path, handle, cookie } = await openLoginPage();
      const res = await send(path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, "CF-Connecting-IP": "203.0.113.7" },
        body: new URLSearchParams({ handle, email: `person${i}@example.com`, password: "wrong", "cf-turnstile-response": "ok" }),
      });
      texts.push(await res.text());
    }
    expect(texts.slice(0, 5).every((t) => t.includes("didn&#39;t accept"))).toBe(true);
    expect(texts[5]).toContain("Too many tries");
    expect(calls.filter((c) => c.includes("sso.garmin.com"))).toHaveLength(5);
  });

  it("limits repeated tries for one email across addresses", async () => {
    const { calls } = mockFetch(
      on(SITEVERIFY, () => json({ success: true })),
      on("https://sso.garmin.com/", () => json({ responseStatus: { type: "INVALID_USERNAME_PASSWORD" } })),
    );
    const texts: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { path, handle, cookie } = await openLoginPage();
      const res = await send(path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, "CF-Connecting-IP": `198.51.100.${i + 1}` },
        body: new URLSearchParams({ handle, email: "Same.Person@example.com", password: "wrong", "cf-turnstile-response": "ok" }),
      });
      texts.push(await res.text());
    }
    expect(texts[5]).toContain("Too many tries");
    expect(calls.filter((c) => c.includes("sso.garmin.com"))).toHaveLength(5);
  });

  it("rejects a post whose consent handle is not bound to the browser", async () => {
    const { path, handle } = await openLoginPage();
    const { calls } = mockFetch(on(SITEVERIFY, () => json({ success: true })));
    const res = await post(path, "", { handle, email: "someone@example.com", password: "fake-password", "cf-turnstile-response": "ok-token" });
    expect(res.status).toBe(400);
    expect(calls.filter((c) => c.includes("garmin.com"))).toEqual([]);
  });
});
