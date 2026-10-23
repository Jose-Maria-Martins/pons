import OAuthProvider, { OAuthError, type TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import icon from "../assets/icon.png";
import { initializeInfo, platformOf, requestContext, track } from "./analytics.js";
import type { GarminAuth, Props } from "./garmin/api.js";
import { handleAuthorize } from "./login/authorize.js";
import { fetchTimeZone, refreshGarminAuth } from "./login/garmin.js";
import { pickLang } from "./login/i18n.js";
import { privacyPage } from "./login/page.js";
import { createServer } from "./mcp/server.js";

// Refresh Garmin's token when it has less than this left. Pons access tokens last 1 h, so a token
// with 3 h left is still valid for every access token issued from it.
const REFRESH_WITHIN_SECONDS = 3 * 3600;

/** A Pons access token must not outlive the Garmin token inside it: give it a shorter life when Garmin's has under an hour left. */
function accessTokenTTLFor(garmin: GarminAuth): { accessTokenTTL: number } | undefined {
  const remaining = garmin.expiresAt - Math.floor(Date.now() / 1000);
  return remaining < 3600 ? { accessTokenTTL: Math.max(60, remaining - 60) } : undefined;
}

/**
 * On a Pons refresh, keep the Garmin token fresh. Garmin's answer decides whether the grant lives on.
 * Grants made before props held the user id or the time zone get them here, on their first refresh.
 * Either grant type caps the Pons access token's life at what is left of the Garmin token's.
 */
export async function tokenExchangeCallback({ grantType, props, userId }: TokenExchangeCallbackOptions<Env>) {
  const stored = props as Props;
  if (grantType === "authorization_code") return accessTokenTTLFor(stored.garmin);
  if (grantType !== "refresh_token") return;
  let current: Props = { ...stored, userId };
  if (current.garmin.expiresAt - Math.floor(Date.now() / 1000) <= REFRESH_WITHIN_SECONDS) {
    const refreshed = await refreshGarmin(current.garmin);
    current = { ...current, garmin: refreshed };
  }
  if (!current.timeZone) {
    // One try; a failure leaves it missing, so the next refresh tries again.
    const timeZone = await fetchTimeZone(current.garmin.access);
    if (timeZone) current = { ...current, timeZone };
  }
  const changed = current.garmin !== stored.garmin || current.userId !== stored.userId || current.timeZone !== stored.timeZone;
  const cap = accessTokenTTLFor(current.garmin);
  return changed || cap ? { ...(changed ? { newProps: current } : {}), ...cap } : undefined;
}

/** The refreshed Garmin token. If Garmin refuses or is down, throws the OAuth error that decides whether the grant lives on. */
async function refreshGarmin(garmin: GarminAuth): Promise<GarminAuth> {
  const result = await refreshGarminAuth(garmin);
  if (result.ok) return result.auth;
  console.log(JSON.stringify({ pons_garmin_refresh: result.reason }));
  if (result.reason === "rejected") {
    // Garmin no longer accepts this login: revoke the grant, so Claude asks the user to reconnect.
    throw new OAuthError("invalid_grant", { description: "The Garmin login expired. Connect Pons again." });
  }
  // Garmin is busy or down: keep the grant, and let the client try again later.
  throw new OAuthError("temporarily_unavailable", {
    description: "Garmin is not available right now. Try again in a moment.",
    statusCode: result.reason === "rate_limited" ? 429 : 503,
    headers: { "Retry-After": "60" },
  });
}

const mcpHandler = createMcpHandler(({ requestInfo }) => createServer(requestInfo && new URL(requestInfo.url).origin), { route: "/mcp" });

/** Record the client's name and version when the request is an MCP initialize. Never blocks or breaks the request. */
async function trackInitialize(request: Request, env: Env, props: Partial<Props> | undefined, platform: ReturnType<typeof platformOf>) {
  // Analytics only: without a Content-Length (a chunked body) the size is unknown, so skip it.
  const length = Number(request.headers.get("Content-Length"));
  if (request.method !== "POST" || !(length > 0 && length <= 100_000)) return;
  try {
    const info = initializeInfo(await request.clone().json());
    if (info) track(env, { type: "initialize", name: info.name, detail: info.version, platform, userId: props?.userId });
  } catch {
    // Not JSON: the MCP handler will answer it.
  }
}

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const platform = platformOf(request.headers.get("User-Agent"));
    await trackInitialize(request, env, ctx.props as Partial<Props> | undefined, platform);
    return requestContext.run({ env, platform }, () => mcpHandler(request, env, ctx));
  },
};

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return handleAuthorize(request, env);
    if (pathname === "/privacy" && request.method === "GET") {
      const { lang, setCookie } = pickLang(request);
      const res = privacyPage(env.SOURCE_URL, lang);
      if (setCookie) res.headers.append("Set-Cookie", setCookie);
      return res;
    }
    if ((pathname === "/icon.png" || pathname === "/favicon.ico") && request.method === "GET") {
      return new Response(icon, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    }
    return new Response("Pons: a read-only Garmin connector for Claude.", { status: 404 });
  },
};

// The OAuth library needs the server's canonical URL, which is only known from a request.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      accessTokenTTL: 3600,
      tokenExchangeCallback,
      refreshTokenTTL: 90 * 24 * 3600,
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
