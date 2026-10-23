import { afterEach, describe, expect, it, vi } from "vitest";
import { pickLang } from "../src/login/i18n.js";
import { openLoginPage, send } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const COOKIE = "__Host-pons_lang=pt; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax";
const req = (headers: Record<string, string> = {}, query = "") => new Request(`https://pons.example.test/authorize${query}`, { headers });
const accepting = (value: string) => pickLang(req({ "Accept-Language": value }));

describe("pickLang", () => {
  it("takes Portuguese from pt, pt-PT and pt-BR", () => {
    for (const tag of ["pt", "pt-PT", "pt-BR"]) expect(accepting(tag)).toEqual({ lang: "pt" });
  });

  it("uses the highest q-value among the supported languages", () => {
    expect(accepting("fr, pt;q=0.8").lang).toBe("pt");
    expect(accepting("en-GB,pt;q=0.9").lang).toBe("en");
    expect(accepting("pt;q=0.5, en;q=0.7").lang).toBe("en");
    expect(accepting("en;q=0, pt;q=0.1").lang).toBe("pt");
  });

  it("falls back to English", () => {
    expect(pickLang(req()).lang).toBe("en");
    expect(accepting("fr").lang).toBe("en");
    expect(accepting("*").lang).toBe("en");
  });

  it("prefers the cookie to the header", () => {
    expect(pickLang(req({ Cookie: "a=b; __Host-pons_lang=pt", "Accept-Language": "en" }))).toEqual({ lang: "pt" });
    expect(pickLang(req({ Cookie: "__Host-pons_lang=xx", "Accept-Language": "pt" })).lang).toBe("pt");
  });

  it("prefers ?lang= to the cookie, and sets the cookie", () => {
    expect(pickLang(req({ Cookie: "__Host-pons_lang=en", "Accept-Language": "en" }, "?lang=pt"))).toEqual({ lang: "pt", setCookie: COOKIE });
  });

  it("ignores an invalid ?lang=", () => {
    expect(pickLang(req({ Cookie: "__Host-pons_lang=pt" }, "?lang=xx"))).toEqual({ lang: "pt" });
    expect(pickLang(req({}, "?lang=xx"))).toEqual({ lang: "en" });
  });
});

describe("the login page", () => {
  it("is English without a preference", async () => {
    const { html, page } = await openLoginPage();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Sign in");
    expect(page.headers.getSetCookie().some((c) => c.startsWith("__Host-pons_lang="))).toBe(false);
  });

  it("follows Accept-Language", async () => {
    const { path } = await openLoginPage();
    const html = await (await send(path, { headers: { "Accept-Language": "pt-PT" } })).text();
    expect(html).toContain('<html lang="pt-PT">');
    expect(html).toContain("Ligar a sua conta Garmin");
    expect(html).toContain("Iniciar sessão");
    expect(html).toContain("<b>Test Client</b> (client.example) está a pedir");
  });

  it("sets the cookie for ?lang=pt, and the switch link keeps the OAuth params", async () => {
    const { path } = await openLoginPage();
    const res = await send(`${path}&lang=pt`);
    const html = await res.text();

    expect(res.headers.getSetCookie()).toContain(COOKIE);
    expect(html).toContain("Iniciar sessão");
    expect(html).toContain('<nav class="lang" aria-label="Language / Idioma">');
    expect(html).toContain('<span aria-current="true">Português</span>');

    const link = /<a href="([^"]+)" lang="en" hreflang="en">English<\/a>/.exec(html)?.[1] ?? "";
    const url = new URL(link.replaceAll("&amp;", "&"), "https://pons.example.test");
    const original = new URL(path, "https://pons.example.test").searchParams;
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("lang")).toBe("en");
    for (const [key, value] of original) expect(url.searchParams.get(key)).toBe(value);
  });

  it("follows the cookie", async () => {
    const { path } = await openLoginPage();
    const html = await (await send(path, { headers: { Cookie: "__Host-pons_lang=pt", "Accept-Language": "en" } })).text();
    expect(html).toContain("Iniciar sessão");
  });
});

describe("/privacy", () => {
  it("is available in Portuguese, remembers the choice, and is not cached publicly", async () => {
    const res = await send("/privacy?lang=pt");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('<html lang="pt-PT">');
    expect(html).toContain("Privacidade do Pons");
    expect(html).toContain("90 dias");
    expect(html).toContain("durante um ano");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toContain(COOKIE);
    expect(html).toContain('<a href="/privacy?lang=en" lang="en" hreflang="en">English</a>');
  });

  it("says 90 days and mentions the language cookie in English", async () => {
    const res = await send("/privacy");
    const html = await res.text();
    expect(html).toContain("up to 90 days");
    expect(html).toContain("language choice");
    expect(html).toContain('<a href="/privacy?lang=pt" lang="pt-PT" hreflang="pt-PT">Português</a>');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
