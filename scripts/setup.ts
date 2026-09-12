/**
 * One-command setup: validate credentials → generate types → build → deploy →
 * seed → print the participant links.
 *
 * Everything Cloudflare-side is provisioned declaratively by `wrangler deploy`
 * from wrangler.jsonc (Worker, both Durable Object namespaces with SQLite
 * storage, the Workflow, the Workers AI binding). No REST provisioning, no
 * dashboard steps.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REQUIRED_ENV = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "SEED_TOKEN"] as const;

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
        `  SEED_TOKEN is yours to choose — generate one with \`openssl rand -hex 32\`.\n` +
        `  See README ("Cloudflare API token permissions" and "Seeding a decision").`
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

  // 3–5. Types, build, deploy. The operator token goes up with the deploy
  //       rather than through `wrangler secret put`, because a Worker that
  //       does not exist yet cannot be given a secret in advance — and this is
  //       the same command on a first deploy and on the hundredth.
  run("Generating Worker types", "npx", ["wrangler", "types", "env.d.ts"]);
  run("Building client + Worker", "npm", ["run", "build"]);
  const deployOutput = withSecretsFile(process.env.SEED_TOKEN!, (path) =>
    run("Deploying to Cloudflare", "npx", ["wrangler", "deploy", "--secrets-file", path], true)
  );

  // 6. Seed a decision into the deployment that was just made — by URL, over
  //    HTTPS, through the same endpoint any operator would use.
  const url = parseDeployedUrl(deployOutput);
  if (!url) {
    console.error(
      "\n✗ Deployed, but could not find the application URL in wrangler's output.\n" +
        "  Seed it yourself once you have the URL:\n" +
        "    npm run seed -- https://<your-worker>.workers.dev"
    );
    process.exit(1);
  }
  run("Seeding a decision", "node", ["scripts/seed.ts", url]);

  console.log("\n✓ Setup complete.");
  console.log(`  Application: ${url}`);
  console.log("  Open one of the participant links above — they are the only way in.");
}

/**
 * Runs `body` with a file holding the Worker's secrets, and removes it however
 * that goes.
 *
 * Wrangler wants secrets for a first deploy as a file; the token is already on
 * this machine, so writing it to a private temporary directory for the length
 * of one command adds no exposure that was not already there. It never lands
 * in the repository, and it does not survive the deploy.
 */
function withSecretsFile<T>(seedToken: string, body: (path: string) => T): T {
  const path = join(mkdtempSync(join(tmpdir(), "adf-secrets-")), "secrets.env");
  writeFileSync(path, `SEED_TOKEN=${seedToken}\n`, { mode: 0o600 });
  try {
    return body(path);
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
}

// Guarded so the pure helpers above stay importable from tests.
if (process.argv[1]?.endsWith("setup.ts")) main();
