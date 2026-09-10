/**
 * One-command setup: validate credentials → generate types → build → deploy →
 * seed → print URLs.
 *
 * Everything Cloudflare-side is provisioned declaratively by `wrangler deploy`
 * from wrangler.jsonc (Worker, both Durable Object namespaces with SQLite
 * storage, the Workflow, the Workers AI binding). No REST provisioning, no
 * dashboard steps.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const REQUIRED_ENV = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as const;

/** Names of required variables that are missing or blank. Exported for tests. */
export function missingEnv(
  env: Record<string, string | undefined>,
  required: readonly string[] = REQUIRED_ENV
): string[] {
  return required.filter((name) => !env[name]?.trim());
}

/** First https://…workers.dev URL in wrangler's deploy output, if any. */
export function parseDeployedUrl(output: string): string | undefined {
  return output.match(/https:\/\/[^\s"']+\.workers\.dev/)?.[0];
}

function run(label: string, command: string, args: string[], capture = false, hint?: string) {
  console.log(`\n▸ ${label}`);
  const result = spawnSync(command, args, {
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    console.error(`\n✗ ${label} failed (exit ${result.status ?? "signal"}).`);
    if (hint) console.error(hint);
    process.exit(result.status ?? 1);
  }
  const stdout = result.stdout?.toString() ?? "";
  if (capture) process.stdout.write(stdout);
  return stdout;
}

function main() {
  // 1. Credentials.
  if (existsSync(".env")) process.loadEnvFile(".env");
  const missing = missingEnv(process.env);
  if (missing.length > 0) {
    console.error(
      `✗ Missing required environment variable(s): ${missing.join(", ")}\n` +
        `  Copy .env.example to .env and fill them in, or export them in your shell.\n` +
        `  See README ("Cloudflare API token permissions").`
    );
    process.exit(1);
  }

  // 2. Cloudflare authentication — via Wrangler, so a bad token fails here with a
  //    clear message rather than midway through a deploy. Note that `whoami`
  //    needs Account Settings: Read to list accounts, which a deploy-only token
  //    might omit, so name that scope rather than just reporting an exit code.
  run(
    "Validating Cloudflare credentials",
    "npx",
    ["wrangler", "whoami"],
    false,
    "  The token may be invalid, or may be missing a scope `whoami` itself needs:\n" +
      "    • Account → Account Settings → Read  (required to list your accounts)\n" +
      "    • User → User Details → Read         (only to display your email)\n" +
      "  See README (\"Cloudflare API token permissions\")."
  );

  // 3–5. Types, build, deploy.
  run("Generating Worker types", "npx", ["wrangler", "types", "env.d.ts"]);
  run("Building client + Worker", "npm", ["run", "build"]);
  const deployOutput = run("Deploying to Cloudflare", "npx", ["wrangler", "deploy"], true);

  // 6. Seed the demonstration scenario (implemented in M7; a no-op until then).
  run("Seeding demonstration scenario", "node", ["scripts/seed.ts"]);

  // 7. URLs.
  const url = parseDeployedUrl(deployOutput);
  console.log("\n✓ Setup complete.");
  console.log(url ? `  Application: ${url}` : "  Application: see the deploy output above for the URL.");
  console.log("  Participant links for the seeded decision are printed by `npm run seed` (M7).");
}

// Guarded so the pure helpers above stay importable from tests.
if (process.argv[1]?.endsWith("setup.ts")) main();
