# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Milestones

Work is organised as milestones M0–M8. **M0 (Cloudflare-as-code setup) and M1 (application spine) are complete** — the rest of `src/` is a deployable stub with a comment naming the milestone that fills it in. M2 (Frame → Submit → Reveal) is next.

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
- **Relative imports need the `.ts` extension** (`./agents/decision.ts`) — `verbatimModuleSyntax` + `allowImportingTsExtensions`.
- **`env.d.ts` is generated and gitignored.** Never hand-edit it. Run `npm run types` after changing any binding in `wrangler.jsonc`.
- **`npm run dev` requires live Cloudflare credentials.** The `AI` binding is `remote: true` (there is no local Workers AI) and connects eagerly at startup.
- **`.env` holds Cloudflare CLI credentials only.** `wrangler.jsonc` declares `"secrets": { "required": [] }` specifically to stop Wrangler loading `.env` into the *Worker's* env. Leave it unless the Worker genuinely needs a secret.
- **`vitest.config.ts` is deliberately separate from `vite.config.ts`** — loading the Cloudflare plugin would boot Miniflare and demand credentials. Worker-runtime tests arrive in M8 via `@cloudflare/vitest-pool-workers`.
- **`scripts/` and `evals/` run under Node's built-in type stripping** (Node ≥ 22.18, no `tsx`), so they must avoid TS that needs emit: enums, namespaces, decorators, parameter properties.
- **`npm run eval` exits 1 by design** until M4 implements it. Not a broken build.

## Git

Commit directly to `main`. One-line imperative subjects, matching existing history (`Wire Tailwind CSS v4 into the build`).
