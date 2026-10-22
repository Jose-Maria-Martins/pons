import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { handleAuthorize } from "./login/authorize.js";
import { createServer } from "./mcp/server.js";

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
