# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Milestones

Work is organised as milestones M0–M8. **M0 (Cloudflare-as-code setup), M1 (application spine), M2 (decision lifecycle), M3 (discussion + realtime), M4 (facilitator foundation), M5 (decision intelligence), M6 (close + team history) and M7 (seeded demonstration + operator decision creation) are complete.** M8 (documentation) is next.

The canonical plan is **Revision 1.8**, which the user holds outside the repo; `docs/implementation-plan.md` is still Revision 1.6 and describes neither M6 nor M7 as built.

Before implementing any milestone, read `docs/requirements.md` (what the product must do) and `docs/implementation-plan.md` (how the repo gets there). They are the authority; `README.md` describes only what is built so far.

## Product constraint

**The facilitator facilitates disagreement. It does not make the decision, recommend an option, or coach participants.** Any feature or prompt that nudges the team toward an answer is wrong, however helpful it seems.

## State ownership

- `DecisionAgent` (SQLite DO) — transactional authority for one *active* decision.
- `TeamAgent` (SQLite DO) — *closed* decision history only. One implicit team in the MVP, addressed by `DEFAULT_TEAM_ID` (`"default"`). M7 introduced decision creation, not team creation: the single implicit team is a documented MVP limitation, not a gap waiting on a milestone.
- `FacilitatorWorkflow` — durable AI execution. Reads state from the Decision Agent; it is **not** a system of record and never owns the transcript. It hands results back through `applyAnalysis()`/`failAnalysis()`; the Agent decides whether to apply them.
- The **realtime projection** (`DecisionRealtimeState`) is derived from SQLite on every read, never accumulated in a counter. It carries counts and versions only; a browser that sees it move re-reads from the Agent.

## Commands

`npm run check` is the typecheck (`tsc --noEmit`) — there is no linter. `npm run types` regenerates `env.d.ts`. See README for the rest.

## Gotchas

- **`tsconfig.json` must stay on `"target": "ES2021"`.** ES2022 turns on `useDefineForClassFields`, which silently breaks the `@callable()` TC39 decorator at runtime. Never set `experimentalDecorators`.
- **`run_worker_first` globs need a segment to match.** `"/d/*"` does not match `/d`, so a bare `/d` request is served by the asset handler and never reaches the Worker — that is why framing is `POST /d/new`.
- **`POST /admin/decisions` is the only way a decision is created, and the whole administrative surface.** One creation operation: no listing, no reads, no deletes, no admin UI. It is for the operator who deployed the application, authenticated by the `SEED_TOKEN` Worker secret (401 without it, 503 on a deployment that was never given one), and the plan (§4.1) still rejects a *public* creation endpoint. It replaced the `/d/new` dev fixture in M7.
- **A seeded decision is an ordinary decision, and nothing may make it otherwise.** `frameDecision()` takes optional `submissions` and backdated `messages`; everything else — Reveal, the transcript, the facilitator — is the normal path. There is no demo mode and no seeded flag, so there is nothing to branch on and nothing to add. The seeded scenario's facilitator state is produced by scheduling a real `DISCUSSION` analysis over the seeded thread, never supplied: the requirement is that the facilitator operate against the actual discussion.
- **Seeded history is validated before the first insert.** Indices into `participants`/`options` rather than ids the caller cannot know, the same `validateSubmission`/`validateMessageBody` a live one goes through, and messages sorted oldest-first so `seq` agrees with the clock. State that could not have arisen legitimately is forged state, not pre-existing state.
- **`setState()` must happen after the transaction, never inside it.** A broadcast cannot be rolled back, so a projection published from inside `transactionSync` could describe a decision that never committed. Same rule, same reason, as scheduling the Workflow.
- **Facilitator state that survives an analysis unchanged keeps its timestamp.** Every run rewrites the whole working model, so stamping `now` on every row would make everything look freshly changed — and both "what changed since your last visit" and the intervention gate read that difference. `unchanged()` in `decision.ts` is the rule; breaking it makes the brief report phantom changes and the facilitator repeat itself.
- **The intervention gate compares a state digest, not a string.** An issue key plus `materialDigest()` — cruxes, conflicts, current positions, and assumptions whose status is *not* OPEN — is what decides whether an issue already raised may be raised again. **Open assumptions are excluded on purpose:** the facilitator adds one on almost every message, so including them moved the digest every analysis and the gate never closed. Its remaining ceiling is deliberate and documented in the README: the digest is decision-wide, not per-issue.
- **`scripts/verify.ts` is the end-to-end check, and it earns its keep.** It drives one participant over the real WebSocket while a browser drives the other; both defects it found — the gate above, and position changes stated in a participant's own words being ignored — were invisible to the test suite. Run it against `npm run dev` after changing the facilitator.
- **`getCurrentStateBrief()` is read once per opening, never on a projection change.** Reading it *is* the visit: it writes `last_visited_at`. A client that re-read it on every realtime update would reset its own "since your last visit" boundary to seconds ago.
- **`validateStateChange()` is what stops a browser forging the projection.** The Agents SDK relays a client `cf_agent_state` message into agent state by default; the Decision Agent refuses any update whose source is not `"server"`. `setConnectionReadonly()` is *not* the tool for this — it also makes the Agent's own `setState()` throw inside any `@callable()`.
- **Agent mutations belong in one synchronous `ctx.storage.transactionSync` body.** A Durable Object only interleaves at an `await`, so a sync body cannot be observed half-applied — that, not a lock, is what makes submission and Reveal atomic. `this.sql` is synchronous; keep it that way and schedule Workflows *after* the transaction returns.
- **Relative imports need the `.ts` extension** (`./agents/decision.ts`) — `verbatimModuleSyntax` + `allowImportingTsExtensions`.
- **`env.d.ts` is generated and gitignored.** Never hand-edit it. Run `npm run types` after changing any binding in `wrangler.jsonc`.
- **`npm run dev` requires live Cloudflare credentials.** The `AI` binding is `remote: true` (there is no local Workers AI) and connects eagerly at startup.
- **`.env` holds Cloudflare CLI credentials and `SEED_TOKEN`, and only `SEED_TOKEN` reaches the Worker.** `wrangler.jsonc` declares `"secrets": { "required": ["SEED_TOKEN"] }`; when that list is present Wrangler binds *only* the names on it, so the CLI credentials still never become Worker bindings. Adding a name to that list is what lets a secret through — do not add one the Worker does not genuinely need.
- **A first deploy cannot `wrangler secret put`.** The Worker does not exist yet, so `wrangler deploy --secrets-file <path>` is the only way a required secret can be set on one; `scripts/setup.ts` writes a 0600 file in a temp dir for the length of the command and removes it afterwards. Subsequent deploys inherit the secret either way.
- **`vitest.config.ts` is deliberately separate from `vite.config.ts`** — loading the *Cloudflare* plugin would boot the whole app. It defines two projects: `unit` (Node) and `agents` (real workerd, via `@cloudflare/vitest-pool-workers`). Run one with `npm run test:unit` / `npm run test:agents`.
- **The `agents` test project must load `agents/vite` too.** Oxc cannot lower the TC39 decorator behind `@callable()`, so without that plugin every file in `test/agents` dies with `SyntaxError: Invalid or unexpected token` — and the message names the test, not the decorator.
- **`remoteBindings: false` keeps the test suite credential-free.** The `AI` binding is `remote: true`; leave it on and running tests needs a live token.
- **The runtime suites share `test/agents/harness.ts`.** It frames and reveals a decision, stubs the Workflow with a recorder, and reads board/brief/positions straight out of the instance. Add a helper there rather than a fourth copy of `discussing()`.
- **Don't assert Agent rejections with `expect(...).rejects`.** A Durable Object RPC call returns workerd's pipelining thenable, and that matcher leaves an unhandled rejection which fails the run even though every test passed. `test/agents` uses a `refusedWith()` try/catch helper instead.
- **Tooling needs npm ≥ 11 and vitest 4.x.** `vitest-pool-workers` peers `vitest@^4`, and npm 10.9.8 crashes (`edgesOut`) resolving vitest 4's peer graph. `npm ci` from the committed lockfile is fine on either.
- **`scripts/` and `evals/` run under Node's built-in type stripping** (Node ≥ 22.18, no `tsx`), so they must avoid TS that needs emit: enums, namespaces, decorators, parameter properties.
- **The closing memo's list fields are selections, not compositions.** The prompt hands the model the exact statements in facilitator state and `grounded()` in `parse.ts` drops anything that is not one of them, keeping the facilitator's wording rather than the model's. `closingKnownState()` builds that set for the prompt *and* the validator — one function on purpose, or the model gets asked for something it is then penalised for giving.
- **The memo never carries a model-supplied outcome.** It is copied from the closed decision, and the closing JSON schema has no field for one. Do not add one "for validation": the guarantee is structural, and a field to check is weaker than a field that does not exist.
- **Free-form prose is grounded by the prompt, not by a validator, and that is accepted.** The memo's `reasoning` and the intervention message are the two fields no deterministic check can reach; the README records it under "Grounding limitation (intentional, MVP)". Do not close it with a second model judging the first — that is not validation, it is another untrusted output in the same position. Tighten the prompt or the evaluation instead.
- **Dissent is grounded against final positions, per line.** `groundedDissent()` in `parse.ts` drops a line that names nobody holding a position, and one that puts a named participant on an option they did not end on. Only options somebody actually holds are matched — otherwise a label like "Other" becomes a word the memo may not contain. Keep it deterministic: a second model call to check the first one is not validation.
- **`closingMemoStatus` is deliberately not `facilitatorStatus`.** A discussion analysis can still be in flight when the owner closes; the two are unrelated processes and must not share `facilitator_meta.analysis_running`. Closing synthesis does not claim the analysis slot — the memo row's own status is what makes it run once.
- **`applyAnalysis()` refuses everything once the decision is not `DISCUSS`.** Not "suppress the intervention" — nothing lands, because a closed decision is frozen and the memo is written from what was committed before the close. `failAnalysis()` likewise schedules no follow-up after closing.
- **Significant learnings are derived, the memo's `refutedAssumptions` are not.** Team history takes assumptions with status `CHALLENGED` or `REFUTED` straight from state; the memo's list is the model's selection from the same set. They can legitimately differ, and that is the point.
- **The `/team/history/:id` route is verification infrastructure.** Guarded by `import.meta.env.DEV` — the last such route — and needs `"/team/*"` in `run_worker_first` or the asset handler swallows it in dev. It is the one part of the lifecycle that cannot be verified against a deployed instance; the memo reaching `READY` is the observable signal there, and the history write is the same Workflow step. `TeamAgent.getClosedDecision()` is a plain RPC, never `@callable()` — the Team Agent has no session model.
- **The brief's "since" boundary is strict (`createdAt > since`).** Tests fast enough to post in the same millisecond as the visit that recorded the boundary see nothing new; `afterTheVisit()` in `intelligence.test.ts` is the fix, not a change to the comparison.
- **`npm run eval` needs live Cloudflare credentials** and calls Workers AI over REST from Node. It exits non-zero when a criterion fails — that is a finding, not a broken build.

## Facilitator (M4)

- **`max_tokens` is 8192, and a truncated response is invalid JSON, not a short answer.** M5's wider response cut a run off mid-array at 4096. If the schema grows again, re-run `npm run eval` and watch the "valid structured output" line before anything else.
- **The model is `@cf/openai/gpt-oss-120b`, not Llama 3.3.** The requirements name Llama 3.3 *subject to the evaluation*, and it failed it: 57% assumption recall against a bar of 80%, stable across runs. Do not switch back without re-running `npm run eval`.
- **Workers AI returns structured output already parsed.** In `json_schema` mode `result.response` is an object, not a string — `parseAnalysis()` accepts either, and `completionFrom()` also unwraps the OpenAI-shaped `choices[0].message.content` that the OpenAI models return through the same binding.
- **OpenAI-shaped models want the schema wrapped.** `response_format.json_schema` must be `{ name, strict, schema }` for them, not the bare schema Workers AI's own models take. `RESPONSE_FORMAT` in `prompt.ts` is the single copy; the Workflow and the eval both use it.
- **A Durable Object RPC result is `Disposable`, which a Workflow step will not accept as its own return type.** Annotate the callback (`async (): Promise<FacilitatorContext> => agent.getFacilitatorContext()`) rather than casting the result.
- **`facilitator_meta.analysis_running` is a timestamp, not a flag** — 0 when idle, otherwise when the run claimed the slot. A run that dies without reporting loses the slot after `ANALYSIS_TIMEOUT_MS`.
- **The facilitator's own message must never schedule analysis.** `postIntervention()` inserts directly for that reason; do not route it through `postMessageFor()`.
- **`npm run eval` imports the product's prompt and validator from `src/`.** Keep it that way — an evaluation with its own copy of the prompt measures nothing.

## Git

Commit directly to `main`. One-line imperative subjects, matching existing history (`Wire Tailwind CSS v4 into the build`).
