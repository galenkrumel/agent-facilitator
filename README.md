# Async Decision Facilitator

A small team makes an asynchronous decision. Everyone commits privately, then
discusses openly. A neutral AI facilitator helps the team surface conflicting
assumptions — it does not make the decision, recommend an option, or coach
participants.

> **Implementation status: M4 (facilitator foundation).**
> The deployment path is in place (M0) and a decision can be framed and opened
> through a participant link (M1). A participant submits a private initial
> position, and the decision reveals — automatically once everyone has
> answered, or when the owner declares submissions complete — moving from
> `SUBMIT` to `DISCUSS` and publishing the positions (M2). The revealed
> decision has a live discussion: participants post to one shared chronological
> thread and see each other's messages without refreshing (M3). The facilitator
> now reads the decision after the Reveal and after each message, and may post
> a neutral intervention into the thread (M4). The participant-facing board,
> the Current State Brief, position changes, closing and team history are built
> in M5–M8; the full documentation required by M8 replaces this file's later
> sections.

## Architecture (as configured)

| Component | Role |
|---|---|
| Worker (`src/server/index.ts`) | Thin. Resolves participant links into sessions, serves the SPA, routes Agents SDK traffic. Holds no state. |
| `DecisionAgent` (SQLite Durable Object) | Transactional authority for one active decision. |
| `TeamAgent` (SQLite Durable Object) | Closed decision history only. |
| `FacilitatorWorkflow` (Workflow) | Durable AI execution: model invocation, retry, output validation. Not a system of record. |
| Workers AI (`AI` binding) | Model runtime. `@cf/openai/gpt-oss-120b`, chosen by the model evaluation below. |
| Static assets | React 19 client (Vite, Tailwind CSS v4), SPA fallback. |

Everything above is declared in `wrangler.jsonc` and provisioned by
`wrangler deploy`. There are no manual dashboard steps and no REST
provisioning.

## Framing a decision and opening it

Framing is **not a product capability.** There is no user-facing way to create
a decision, and `POST /d/new` is a *development fixture only*: the branch is
compiled out of the deployed Worker, so on a deployed instance that path falls
through to the SPA like any other unknown URL. It exists so the lifecycle can
be exercised locally until the seeded scenario replaces it in M7. Do not build
on it.

Against the dev server:

```bash
curl -X POST http://localhost:5173/d/new \
  -H 'Content-Type: application/json' \
  -d '{"question":"Ship in February or slip to March?",
       "context":"Two weeks of runway left.",
       "options":["Ship in February","Slip to March"],
       "participants":["Ada","Grace"]}'
```

It returns one participant link per person — the first is the owner — and the
application adds the **Other** option itself. The links are shown **once**:
only their hashes are stored.

Opening a link:

```text
GET /d/:decisionId/p/:credential   Decision Agent validates the credential,
                                   mints a session, sets an HttpOnly cookie
      ↓ 303
GET /d/:decisionId                 SPA shell; the credential is out of the URL
      ↓
WS  /agents/decision-agent/:id     Decision Agent authenticates the cookie,
                                   then serves getBootstrap() from SQLite
```

The credential stays reusable: opening the same link again — another browser,
another device, later — mints another session for the same participant. A
connection without a valid session is closed, not served.

## Submit and Reveal

Each participant submits one private initial position: an option, a confidence
from 1–5, and up to three reasons. Submissions are one-shot and immutable.

Before Reveal, *who* has submitted is visible; *what* they submitted is not.
The bootstrap withholds every submission but the viewer's own.

Reveal is the `SUBMIT → DISCUSS` transition, not a phase. It happens when the
last invited participant submits, or when the owner declares submissions
complete — both through the same server-side path. Participation is voluntary,
so the owner can reveal with submissions outstanding; a non-participant must
not be able to hold the decision up.

At Reveal the submitted positions, confidences and reasons become visible, and
each submission seeds that participant's **current position** — which is
authoritative from then on. A participant who never submitted simply has no
current position: absence of a row, not a row full of nulls. They remain a full
participant and take part in the discussion regardless.

Reveal analysis is handed to the Workflow strictly *after* the transaction
commits. No AI failure can undo a transition participants have already seen.

## Discussion

Once revealed, the decision has one shared thread. Messages are chronological,
immutable and flat: no nested replies, no `@mentions`, no editing, no deletion.
Participants address each other by name and correct themselves in a follow-up.
There is no deadline; the discussion runs until the owner closes the decision
(M6).

A message's canonical order is its `seq`, allocated by SQLite inside the same
synchronous transaction that writes it — never the browser's clock. Messages
carry an author: a participant, or the facilitator, whose messages are a
visibly different voice in the room.

As with Reveal, discussion analysis is handed to the Workflow strictly after
the message commits. AI is not part of the message transaction.

## Realtime

The Decision Agent synchronises a small projection — counts and versions, no
content — to every connected browser through the Agents SDK:

```ts
{ status, participantCount, submittedCount, messageCount,
  messagesVersion, positionsVersion, boardVersion,
  facilitatorStatus, lastActivityAt }
```

A browser that sees the projection move re-reads the decision from the Agent.
So the live path and the refresh path are the same read, and SQLite stays the
single authority: no message body, option or confidence ever rides on the
broadcast, and a live browser cannot drift from a refreshed one.

Every version is derived from the rows themselves rather than kept in a
counter, so it cannot describe a state that was never committed. The projection
is published only after its transaction returns — a broadcast cannot be rolled
back. The SDK also lets a client push state; the Agent refuses any update that
did not come from itself.

## The facilitator

The facilitator reads the decision after the Reveal and after each participant
message, and may post one neutral message into the same thread everyone else
writes to. It surfaces assumptions, cruxes and conflicts; it does not recommend
an option, choose an outcome, or coach anyone. Silence is a valid outcome and
the common one.

Analysis never runs in a participant's request. The Decision Agent commits the
message or the Reveal first, publishes the projection, and only then schedules
the Workflow:

```text
Decision Agent          FacilitatorWorkflow
  commit  ─────────────▶ read state from the Agent
  publish                     ↓
  schedule               Workers AI
                              ↓
                         JSON parse → schema → semantic validation
                              ↓
  apply  ◀──────────── validated FacilitatorAnalysisResult
```

The Workflow owns durable execution and nothing else. It reads the decision
from the Agent rather than carrying a transcript of its own, and the only thing
it can do with its conclusions is hand them back to be validated and applied.

**AI output is untrusted input.** It is parsed, schema-checked, and then
checked against the decision itself: participants are named rather than
identified by UUID and the names must resolve, statuses must be known values,
lists are bounded, and an intervention is held to the same rules as a
participant's message. Application is one synchronous transaction, so an
analysis that still gets something wrong rolls back whole — the facilitator
cannot leave the decision half-updated. Nothing it returns can bypass a domain
invariant: it cannot change a position, close a decision, or write as a
participant.

**One analysis at a time.** The Agent keeps `analysis_running`,
`analysis_pending` and `last_analyzed_seq`. Messages that arrive during a run
set `analysis_pending` instead of starting a second one, and the finishing run
schedules the follow-up. A result whose analyzed range is behind the last
applied one is refused as stale, and a result that arrives with no run in
flight — a retried Workflow step — is ignored rather than applied twice. A run
that dies without reporting loses the slot after five minutes, so one lost
Workflow cannot silence the facilitator for the life of the decision.

**Failure is survivable by design.** If the model fails, returns something that
never passes validation, or the Workflow cannot be started at all, the error is
recorded, the slot is released, and the decision is untouched: messages post,
the discussion continues, and the next message schedules a fresh analysis.
Connected browsers see `facilitatorStatus` go to `ERROR`; nothing a participant
can do is blocked by it.

The facilitator's own messages never schedule analysis — that loop is the whole
reason the rule exists.

## Model evaluation

The requirements name Llama 3.3 *subject to* an evaluation against a scripted
transcript. `npm run eval` is that evaluation: forty messages, three
participants, ten known assumptions, seven conflicts of which two are implicit
(nobody in the transcript notices them). It runs the product's own prompt,
decoding parameters and validator — imported from `src/`, not copied — against
real Workers AI, so it cannot drift from what the facilitator actually does.

| | Llama 3.3 70B | gpt-oss-120b |
|---|---|---|
| Assumption recall (bar: 80%) | **57%** | **97%** |
| Attribution accuracy | 100% | 93% |
| ≥1 of 2 implicit conflicts | 2 of 3 runs | 3 of 3 runs |
| Invented conflicts | 0.3 per run | 0.3 per run |
| Valid structured output, no retry | 3 of 3 runs | 3 of 3 runs |
| Latency per analysis | 17–20s | 25–50s |

**Llama 3.3 did not meet the bar and the model was switched**, as the
requirements provide for. Its failure is specific and stable: it reliably finds
five or six of the ten known assumptions and stops, unchanged by a larger token
budget or a more explicit prompt. Everything else about it is good — perfect
attribution, no invented conflicts, reliable structured output — but a
facilitator that misses half of what a team is assuming is not doing the job.
`@cf/openai/gpt-oss-120b` is two to three times slower, which costs nothing
here: analysis is asynchronous and never on a participant's path.

```bash
npm run eval                    # three runs against the selected model
npm run eval -- --runs=5
npm run eval -- --show          # print the first run's analysis in full
npm run eval -- --model=@cf/…   # score a candidate model
```

The script exits non-zero when a criterion fails, and prints every intervention
it produced — neutrality is not something keyword matching can score, so that
judgement stays with a human reading the output.

## Prerequisites

- Node.js ≥ 22.18 (the scripts are TypeScript run directly by Node's built-in
  type stripping — there is no `tsx`/`ts-node` dependency)
- A Cloudflare account, an API token, and the Account ID

## Setup

```bash
npm install
cp .env.example .env    # add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
npm run setup
```

`npm run setup` validates the credentials, generates Worker types, builds,
deploys, seeds the demonstration scenario (from M7) and prints the application
URL.

## Cloudflare API token permissions

Create the token at **My Profile → API Tokens → Create Token**. Start from the
**Edit Cloudflare Workers** template, then adjust to the three scopes below.

| Scope | Permission | Why this project needs it |
|---|---|---|
| Account → Workers Scripts | **Edit** | Uploading the Worker. Also covers **Durable Objects, the SQLite migration, Workflows, static assets and the observability setting** — none of those have a permission group of their own; they are all managed through the Workers Scripts API. |
| Account → Account Settings | **Read** | `wrangler whoami`, which `npm run setup` uses to validate credentials, needs this to list accounts. Cloudflare's own auto-generated Workers deploy token includes it. |
| Account → Workers AI | **Read** | The `AI` binding. Needed by `npm run dev` (the binding is remote) and by facilitator inference from M4. Every `/accounts/{id}/ai/*` endpoint requires it. |

Set **Account Resources** to the single account you are deploying to. Client IP
filtering and a TTL are optional and safe to add.

### Deliberately excluded

| Scope | Why not |
|---|---|
| Workers KV Storage → Edit | Ships with the *Edit Cloudflare Workers* template, but this project uses no KV. Remove it. |
| User → User Details → Read | Only lets `wrangler whoami` print your email address; without it Wrangler warns but authentication still works. Add it if `npm run setup` fails at the credential check. |
| Workers Tail → Read | Only for `wrangler tail` live logs. Add later if you want them. |
| Workers Observability | No such permission group exists. `observability.enabled` is Worker configuration, applied under Workers Scripts: Edit. |

### Verified against a live deploy

A single **Account API Token** on one account deployed the whole stack in one
`npm run setup`: Worker, static assets, **both SQLite Durable Objects including
the `new_sqlite_classes` migration**, the **Workflow** (`facilitator-workflow`,
provisioned automatically), the Workers AI binding, and `observability.enabled`.

This confirms the key finding: **Durable Objects, Workflows and observability
need no permission of their own.** They are provisioned entirely under
Workers Scripts: Edit. No dashboard step was required for any resource.

`wrangler whoami` also succeeded, so the token carries Account Settings: Read.

Still unproven: whether Workers AI **Read** is enough to *run inference*, as
opposed to merely attaching the binding at deploy time. The binding attached
fine, but no model has been invoked yet. If inference 403s in M4, raise it to
**Edit**.

## Local development

```bash
npm run dev
```

`.env` holds Cloudflare **CLI credentials only.** Wrangler would otherwise also
load `.env` into the *Worker's* `env` — writing the API token into
`dist/.../.dev.vars` and typing it into `Env`. `wrangler.jsonc` declares
`"secrets": { "required": [] }` to stop that. Add a name to that array if the
Worker ever genuinely needs a secret.

Local dev **also requires Cloudflare credentials.** There is no local Workers AI
emulator, so the `AI` binding is declared `remote: true` and Miniflare proxies
it to the real account; it connects eagerly at startup and fails without a
token.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Local dev server (Vite + Miniflare) |
| `npm run build` | Build client and Worker |
| `npm run deploy` | Build and deploy |
| `npm run setup` | Validate → types → build → deploy → seed → print URLs |
| `npm run seed` | Seed the demonstration scenario (M7) |
| `npm test` | Tests — both projects |
| `npm run test:unit` | Pure domain and script tests, in Node |
| `npm run test:agents` | Agent tests, in the real Workers runtime |
| `npm run eval` | Facilitator model evaluation (needs Cloudflare credentials) |
| `npm run types` | Regenerate `env.d.ts` from `wrangler.jsonc` |
| `npm run check` | Typecheck |

## Tests

Two Vitest projects, because the suites need different runtimes.

`test/unit` is plain Node: pure domain rules (submission and message
validation, the authorization table), the facilitator's output validator, and
the Node-side setup script.

`test/agents` runs **inside workerd**, via `@cloudflare/vitest-pool-workers`,
against a real Durable Object and its real SQLite. Atomicity, Durable Object
serialization, race determinism and post-commit Workflow scheduling are claims
about the runtime, so they are tested in it rather than against a stand-in. The
`FacilitatorWorkflow` is the one thing doubled: the tests drive the Agent side
of the boundary directly — claiming and releasing the analysis slot, applying,
refusing a stale result, rolling back a bad one — while `npm run eval` covers
the model itself. Neither project needs Cloudflare credentials: the pool runs
with remote bindings off, which is also why the model is not called from a
test.

**Requires npm ≥ 11.** npm 10.9.8 crashes (`Cannot read properties of null
(reading 'edgesOut')`) resolving Vitest 4's optional peer graph, which
`@cloudflare/vitest-pool-workers` requires. `npm ci` from the committed
lockfile is unaffected; a fresh `npm install` on npm 10 is not.

## Security limitation (intentional, MVP)

Participant identity is a decision-scoped bearer link. **Anyone who possesses a
participant's link can act as that participant.** Links do not expire, are not
single-use, and work from any browser or device. There are no user accounts and
**no account recovery.** These credentials are not appropriate for highly
sensitive information.

What the implementation does do: only SHA-256 hashes of credentials and
sessions are persisted, so the stored state yields no working links; the
credential is exchanged once for an `HttpOnly` session cookie and then leaves
the address bar; and the cookie is scoped per decision, so one browser can hold
sessions for several decisions — as a different participant in each.
