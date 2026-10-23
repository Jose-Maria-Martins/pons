import OAuthProvider, { OAuthError, type TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { Props } from "./garmin/api.js";
import { handleAuthorize } from "./login/authorize.js";
import { refreshGarminAuth } from "./login/garmin.js";
import { createServer } from "./mcp/server.js";

// Refresh Garmin's token when it has less than this left. Pons access tokens last 1 h, so a token
// with 3 h left is still valid for every access token issued from it.
const REFRESH_WITHIN_SECONDS = 3 * 3600;

/** On a Pons refresh, keep the Garmin token fresh. Garmin's answer decides whether the grant lives on. */
async function tokenExchangeCallback({ grantType, props }: TokenExchangeCallbackOptions<Env>) {
  if (grantType !== "refresh_token") return;
  const current = props as Props;
  if (current.garmin.expiresAt - Math.floor(Date.now() / 1000) > REFRESH_WITHIN_SECONDS) return;

  const result = await refreshGarminAuth(current.garmin);
  if (result.ok) return { newProps: { ...current, garmin: result.auth } };
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

const mcpHandler = createMcpHandler(() => createServer(), { route: "/mcp" });

const apiHandler = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => mcpHandler(request, env, ctx),
};

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/authorize") return handleAuthorize(request, env);
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
      refreshTokenTTL: 30 * 24 * 3600,
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
