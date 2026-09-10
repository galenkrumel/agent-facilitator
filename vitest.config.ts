import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: loading the Cloudflare plugin
// would boot Miniflare and require live credentials (the Workers AI binding is
// remote — there is no local Workers AI). Worker-runtime tests arrive in M8 via
// @cloudflare/vitest-pool-workers.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] }
});
