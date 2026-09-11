# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Milestones

Work is organised as milestones M0–M8. **M0 (Cloudflare-as-code setup), M1 (application spine), M2 (decision lifecycle), M3 (discussion + realtime), M4 (facilitator foundation) and M5 (decision intelligence) are complete** — the rest of `src/` is a deployable stub with a comment naming the milestone that fills it in. M6 (close + team history) is next.

Before implementing any milestone, read `docs/requirements.md` (what the product must do) and `docs/implementation-plan.md` (how the repo gets there). They are the authority; `README.md` describes only what is built so far.

## Product constraint

**The facilitator facilitates disagreement. It does not make the decision, recommend an option, or coach participants.** Any feature or prompt that nudges the team toward an answer is wrong, however helpful it seems.

## State ownership

- `DecisionAgent` (SQLite DO) — transactional authority for one *active* decision.
- `TeamAgent` (SQLite DO) — *closed* decision history only.
- `FacilitatorWorkflow` — durable AI execution. Reads state from the Decision Agent; it is **not** a system of record and never owns the transcript. It hands results back through `applyAnalysis()`/`failAnalysis()`; the Agent decides whether to apply them.
- The **realtime projection** (`DecisionRealtimeState`) is derived from SQLite on every read, never accumulated in a counter. It carries counts and versions only; a browser that sees it move re-reads from the Agent.

## Commands

`npm run check` is the typecheck (`tsc --noEmit`) — there is no linter. `npm run types` regenerates `env.d.ts`. See README for the rest.

## Gotchas

- **`tsconfig.json` must stay on `"target": "ES2021"`.** ES2022 turns on `useDefineForClassFields`, which silently breaks the `@callable()` TC39 decorator at runtime. Never set `experimentalDecorators`.
- **`run_worker_first` globs need a segment to match.** `"/d/*"` does not match `/d`, so a bare `/d` request is served by the asset handler and never reaches the Worker — that is why framing is `POST /d/new`.
- **`POST /d/new` is a development fixture, not a product API.** The plan (§4.1) rejects a public decision-creation endpoint; M7 replaces it with seed tooling. It is guarded by `import.meta.env.DEV`, a build-time constant, so the branch is eliminated from the deployed Worker rather than merely refused there. The Agent's `frameDecision()` RPC stays — that is what M7 seeding will use. Do not build on the route.
- **`setState()` must happen after the transaction, never inside it.** A broadcast cannot be rolled back, so a projection published from inside `transactionSync` could describe a decision that never committed. Same rule, same reason, as scheduling the Workflow.
- **Facilitator state that survives an analysis unchanged keeps its timestamp.** Every run rewrites the whole working model, so stamping `now` on every row would make everything look freshly changed — and both "what changed since your last visit" and the intervention gate read that difference. `unchanged()` in `decision.ts` is the rule; breaking it makes the brief report phantom changes and the facilitator repeat itself.
- **The intervention gate compares a state digest, not a string.** An issue key plus `materialDigest()` — every assumption, crux and conflict with its status, and every current position — is what decides whether an issue already raised may be raised again. Its ceiling is deliberate and documented in the README: the digest is decision-wide, not per-issue.
- **`getCurrentStateBrief()` is read once per opening, never on a projection change.** Reading it *is* the visit: it writes `last_visited_at`. A client that re-read it on every realtime update would reset its own "since your last visit" boundary to seconds ago.
- **`validateStateChange()` is what stops a browser forging the projection.** The Agents SDK relays a client `cf_agent_state` message into agent state by default; the Decision Agent refuses any update whose source is not `"server"`. `setConnectionReadonly()` is *not* the tool for this — it also makes the Agent's own `setState()` throw inside any `@callable()`.
- **Agent mutations belong in one synchronous `ctx.storage.transactionSync` body.** A Durable Object only interleaves at an `await`, so a sync body cannot be observed half-applied — that, not a lock, is what makes submission and Reveal atomic. `this.sql` is synchronous; keep it that way and schedule Workflows *after* the transaction returns.
- **Relative imports need the `.ts` extension** (`./agents/decision.ts`) — `verbatimModuleSyntax` + `allowImportingTsExtensions`.
- **`env.d.ts` is generated and gitignored.** Never hand-edit it. Run `npm run types` after changing any binding in `wrangler.jsonc`.
- **`npm run dev` requires live Cloudflare credentials.** The `AI` binding is `remote: true` (there is no local Workers AI) and connects eagerly at startup.
- **`.env` holds Cloudflare CLI credentials only.** `wrangler.jsonc` declares `"secrets": { "required": [] }` specifically to stop Wrangler loading `.env` into the *Worker's* env. Leave it unless the Worker genuinely needs a secret.
- **`vitest.config.ts` is deliberately separate from `vite.config.ts`** — loading the *Cloudflare* plugin would boot the whole app. It defines two projects: `unit` (Node) and `agents` (real workerd, via `@cloudflare/vitest-pool-workers`). Run one with `npm run test:unit` / `npm run test:agents`.
- **The `agents` test project must load `agents/vite` too.** Oxc cannot lower the TC39 decorator behind `@callable()`, so without that plugin every file in `test/agents` dies with `SyntaxError: Invalid or unexpected token` — and the message names the test, not the decorator.
- **`remoteBindings: false` keeps the test suite credential-free.** The `AI` binding is `remote: true`; leave it on and running tests needs a live token.
- **The runtime suites share `test/agents/harness.ts`.** It frames and reveals a decision, stubs the Workflow with a recorder, and reads board/brief/positions straight out of the instance. Add a helper there rather than a fourth copy of `discussing()`.
- **Don't assert Agent rejections with `expect(...).rejects`.** A Durable Object RPC call returns workerd's pipelining thenable, and that matcher leaves an unhandled rejection which fails the run even though every test passed. `test/agents` uses a `refusedWith()` try/catch helper instead.
- **Tooling needs npm ≥ 11 and vitest 4.x.** `vitest-pool-workers` peers `vitest@^4`, and npm 10.9.8 crashes (`edgesOut`) resolving vitest 4's peer graph. `npm ci` from the committed lockfile is fine on either.
- **`scripts/` and `evals/` run under Node's built-in type stripping** (Node ≥ 22.18, no `tsx`), so they must avoid TS that needs emit: enums, namespaces, decorators, parameter properties.
- **`npm run eval` needs live Cloudflare credentials** and calls Workers AI over REST from Node. It exits non-zero when a criterion fails — that is a finding, not a broken build.

## Facilitator (M4)

- **The model is `@cf/openai/gpt-oss-120b`, not Llama 3.3.** The requirements name Llama 3.3 *subject to the evaluation*, and it failed it: 57% assumption recall against a bar of 80%, stable across runs. Do not switch back without re-running `npm run eval`.
- **Workers AI returns structured output already parsed.** In `json_schema` mode `result.response` is an object, not a string — `parseAnalysis()` accepts either, and `completionFrom()` also unwraps the OpenAI-shaped `choices[0].message.content` that the OpenAI models return through the same binding.
- **OpenAI-shaped models want the schema wrapped.** `response_format.json_schema` must be `{ name, strict, schema }` for them, not the bare schema Workers AI's own models take. `RESPONSE_FORMAT` in `prompt.ts` is the single copy; the Workflow and the eval both use it.
- **A Durable Object RPC result is `Disposable`, which a Workflow step will not accept as its own return type.** Annotate the callback (`async (): Promise<FacilitatorContext> => agent.getFacilitatorContext()`) rather than casting the result.
- **`facilitator_meta.analysis_running` is a timestamp, not a flag** — 0 when idle, otherwise when the run claimed the slot. A run that dies without reporting loses the slot after `ANALYSIS_TIMEOUT_MS`.
- **The facilitator's own message must never schedule analysis.** `postIntervention()` inserts directly for that reason; do not route it through `postMessageFor()`.
- **`npm run eval` imports the product's prompt and validator from `src/`.** Keep it that way — an evaluation with its own copy of the prompt measures nothing.

## Git

Commit directly to `main`. One-line imperative subjects, matching existing history (`Wire Tailwind CSS v4 into the build`).
