import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", ".wrangler", "worker-configuration.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // The landing page's scripts run in the browser, where document and window exist.
  { files: ["site/**/*.js"], rules: { "no-undef": "off" } },
);
