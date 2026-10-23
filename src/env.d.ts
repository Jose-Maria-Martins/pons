import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  type Env = Cloudflare.Env;

  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index.js");
    }
    interface Env {
      OAUTH_KV: KVNamespace;
      OAUTH_PROVIDER: OAuthHelpers;
      LOGIN_LIMIT: RateLimit;
      TOOL_LIMIT: RateLimit;
      PONS_EVENTS: AnalyticsEngineDataset;
      TURNSTILE_SITE_KEY: string;
      TURNSTILE_SECRET: string;
      HASH_KEY: string;
      SOURCE_URL: string;
    }
  }
}
