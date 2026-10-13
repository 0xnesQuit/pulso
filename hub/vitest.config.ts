import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// vitest.config.ts runs in Node; the project types target workerd, so declare the bit we use.
declare const process: { env: Record<string, string | undefined> };

export default defineConfig(async () => {
  // Resolved relative to the hub directory (run vitest from there, e.g. `npm test`).
  const migrations = await readD1Migrations("./migrations");
  // Throwaway key generated per test run; never written to disk.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const testHubSecret = btoa(String.fromCharCode(...bytes));
  // Satisfies wrangler's secrets.required check for the test run only.
  process.env.HUB_SECRET = testHubSecret;
  process.env.HUB_INVITE_CODES = "TEST-INVITE, SECOND-CODE";

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, HUB_SECRET: testHubSecret, HUB_INVITE_CODES: "TEST-INVITE, SECOND-CODE" },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      testTimeout: 20_000,
    },
  };
});
