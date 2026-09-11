# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Milestones

Work is organised as milestones M0–M8. **M0 (Cloudflare-as-code setup), M1 (application spine) and M2 (decision lifecycle) are complete** — the rest of `src/` is a deployable stub with a comment naming the milestone that fills it in. M3 (discussion + realtime) is next.

Before implementing any milestone, read `docs/requirements.md` (what the product must do) and `docs/implementation-plan.md` (how the repo gets there). They are the authority; `README.md` describes only what is built so far.

## Product constraint

**The facilitator facilitates disagreement. It does not make the decision, recommend an option, or coach participants.** Any feature or prompt that nudges the team toward an answer is wrong, however helpful it seems.

## State ownership

- `DecisionAgent` (SQLite DO) — transactional authority for one *active* decision.
- `TeamAgent` (SQLite DO) — *closed* decision history only.
- `FacilitatorWorkflow` — durable AI execution. Reads state from the Decision Agent; it is **not** a system of record and never owns the transcript.

## Commands

`npm run check` is the typecheck (`tsc --noEmit`) — there is no linter. `npm run types` regenerates `env.d.ts`. See README for the rest.

## Gotchas

- **`tsconfig.json` must stay on `"target": "ES2021"`.** ES2022 turns on `useDefineForClassFields`, which silently breaks the `@callable()` TC39 decorator at runtime. Never set `experimentalDecorators`.
- **`run_worker_first` globs need a segment to match.** `"/d/*"` does not match `/d`, so a bare `/d` request is served by the asset handler and never reaches the Worker — that is why framing is `POST /d/new`.
- **`POST /d/new` is a development fixture, not a product API.** The plan (§4.1) rejects a public decision-creation endpoint; M7 replaces it with seed tooling. It is guarded by `import.meta.env.DEV`, a build-time constant, so the branch is eliminated from the deployed Worker rather than merely refused there. The Agent's `frameDecision()` RPC stays — that is what M7 seeding will use. Do not build on the route.
- **Agent mutations belong in one synchronous `ctx.storage.transactionSync` body.** A Durable Object only interleaves at an `await`, so a sync body cannot be observed half-applied — that, not a lock, is what makes submission and Reveal atomic. `this.sql` is synchronous; keep it that way and schedule Workflows *after* the transaction returns.
- **Relative imports need the `.ts` extension** (`./agents/decision.ts`) — `verbatimModuleSyntax` + `allowImportingTsExtensions`.
- **`env.d.ts` is generated and gitignored.** Never hand-edit it. Run `npm run types` after changing any binding in `wrangler.jsonc`.
- **`npm run dev` requires live Cloudflare credentials.** The `AI` binding is `remote: true` (there is no local Workers AI) and connects eagerly at startup.
- **`.env` holds Cloudflare CLI credentials only.** `wrangler.jsonc` declares `"secrets": { "required": [] }` specifically to stop Wrangler loading `.env` into the *Worker's* env. Leave it unless the Worker genuinely needs a secret.
- **`vitest.config.ts` is deliberately separate from `vite.config.ts`** — loading the *Cloudflare* plugin would boot the whole app. It defines two projects: `unit` (Node) and `agents` (real workerd, via `@cloudflare/vitest-pool-workers`). Run one with `npm run test:unit` / `npm run test:agents`.
- **The `agents` test project must load `agents/vite` too.** Oxc cannot lower the TC39 decorator behind `@callable()`, so without that plugin every file in `test/agents` dies with `SyntaxError: Invalid or unexpected token` — and the message names the test, not the decorator.
- **`remoteBindings: false` keeps the test suite credential-free.** The `AI` binding is `remote: true`; leave it on and running tests needs a live token.
- **Don't assert Agent rejections with `expect(...).rejects`.** A Durable Object RPC call returns workerd's pipelining thenable, and that matcher leaves an unhandled rejection which fails the run even though every test passed. `test/agents` uses a `refusedWith()` try/catch helper instead.
- **Tooling needs npm ≥ 11 and vitest 4.x.** `vitest-pool-workers` peers `vitest@^4`, and npm 10.9.8 crashes (`edgesOut`) resolving vitest 4's peer graph. `npm ci` from the committed lockfile is fine on either.
- **`scripts/` and `evals/` run under Node's built-in type stripping** (Node ≥ 22.18, no `tsx`), so they must avoid TS that needs emit: enums, namespaces, decorators, parameter properties.
- **`npm run eval` exits 1 by design** until M4 implements it. Not a broken build.

## Git

Commit directly to `main`. One-line imperative subjects, matching existing history (`Wire Tailwind CSS v4 into the build`).
