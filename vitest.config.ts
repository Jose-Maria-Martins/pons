import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Overrides the real site key in wrangler.jsonc, so tests do not depend on the deployed config.
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
          TURNSTILE_SECRET: "test-turnstile-secret",
          HASH_KEY: "test-hash-key",
        },
      },
    }),
  ],
});
