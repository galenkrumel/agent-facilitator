import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";

// Two projects, because the suites need different runtimes.
//
// `unit` is plain Node: pure domain logic and Node-side scripts, fast, with no
// Cloudflare anywhere near it.
//
// `agents` runs inside workerd, against a real Durable Object and its real
// SQLite. Transactionality, Durable Object serialization and post-commit
// Workflow scheduling cannot be demonstrated by a stand-in for the runtime, so
// they are tested in it.
//
// Deliberately not the Cloudflare *Vite* plugin: that boots the whole
// application. The pool builds its own Miniflare from wrangler.jsonc instead,
// with `remoteBindings` off — the AI binding is `remote: true`, and M2 needs no
// model, so connecting it would demand live credentials to run the tests.
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "unit", include: ["test/unit/**/*.test.ts"] }
      },
      {
        plugins: [
          // Same reason as vite.config.ts: Oxc cannot lower the TC39 decorator
          // that `@callable()` uses, so without this the Agent reaches workerd
          // with `@callable()` still in it and every test file fails to parse.
          agents(),
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            remoteBindings: false
          })
        ],
        test: { name: "agents", include: ["test/agents/**/*.test.ts"] }
      }
    ]
  }
});
