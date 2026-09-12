# Async Decision Facilitator

A small team makes an asynchronous decision. Everyone commits privately, then
discusses openly. A neutral AI facilitator helps the team surface conflicting
assumptions — it does not make the decision, recommend an option, or coach
participants.

> **Implementation status: M7 (seeded demonstration & decision creation).**
> The deployment path is in place (M0) and a decision can be framed and opened
> through a participant link (M1). A participant submits a private initial
> position, and the decision reveals — automatically once everyone has
> answered, or when the owner declares submissions complete — moving from
> `SUBMIT` to `DISCUSS` and publishing the positions (M2). The revealed
> decision has a live discussion: participants post to one shared chronological
> thread and see each other's messages without refreshing (M3). The facilitator
> reads the decision after the Reveal and after each message, and may post a
> neutral intervention into the thread (M4). It now also maintains the
> participant-facing board, applies the position changes participants state
> explicitly, asks for a confidence a change did not carry, holds back an
> intervention on an issue nothing has happened to, and writes each participant
> a Current State Brief on opening (M5). The owner can declare an outcome and
> close the decision, after which it is read-only: the facilitator writes a
> closing memo around the outcome without being able to change it, and the
> closed decision is filed in the Team Agent's history (M6). A decision is now
> created by the operator who deployed the application, through one
> authenticated endpoint, and can be created with a history already in it — a
> deployment is seeded with a real discussion already under way (M7). The full
> documentation required by M8 replaces this file's later sections.

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

## Creating a decision, and opening it

Creating a decision is **not a product capability.** There is no user-facing
way to create one: no sign-up, no "new decision" button, nothing a participant
can reach. A decision is created by whoever deploys the application, through
the single administrative endpoint, and everyone else arrives by participant
link.

```bash
curl -X POST https://<your-worker>.workers.dev/admin/decisions \
  -H "Authorization: Bearer $SEED_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"question":"Ship in February or slip to March?",
       "context":"Two weeks of runway left.",
       "options":["Ship in February","Slip to March"],
       "participants":["Ada","Grace"]}'
```

`SEED_TOKEN` is a Worker secret — one you generate (`openssl rand -hex 32`),
set in `.env`, and which `npm run setup` uploads with the deploy. It is never
given to a participant, never sent to a browser, and never written into the
repository. Without it the endpoint answers `401`; on a deployment that was
never given one, `503`.

That is the whole administrative surface: **one creation operation.** No
listing, no reads, no deletes, no admin UI. Everything else about a decision
happens inside the Decision Agent, through an authenticated participant
session.

The response is one participant link per person — the first named is the
owner — and the application adds the **Other** option itself. The links are
shown **once**: only their hashes are stored, so a link that is lost is lost.

### Creating a decision that has already been going on

The same endpoint accepts the history a decision is framed as already having:
`submissions` and backdated `messages`, indexed into the `participants` and
`options` it was just given.

```jsonc
{
  "question": "...", "options": ["...", "..."], "participants": ["Ada", "Grace"],
  "submissions": [{ "participant": 0, "option": 0, "confidence": 4, "reasons": ["..."] }],
  "messages":    [{ "participant": 1, "minutesAgo": 2880, "body": "..." }]
}
```

What comes out is an ordinary decision in `DISCUSS`: the Reveal is the same
Reveal, the transcript is the same transcript, and the facilitator then reads
it exactly as it reads any other discussion. **There is no demo mode.** Nothing
in the application knows or can ask whether a decision was created this way —
the facilitator state a seeded scenario has is state the real facilitator
derived from the real discussion, not a fixture.

History that could not have happened is refused before anything is written: an
index naming nobody, a participant submitting twice, a message posted a
negative number of minutes ago, a body that fails the same validation a live
message does. Messages are stored oldest-first whatever order they were listed
in, so `seq` and the clock agree.

### Seeding a deployment

`npm run seed` is that endpoint with a scenario already written:

```bash
npm run seed -- https://<your-worker>.workers.dev   # or http://localhost:5173
```

The target is an argument rather than a default, because seeding writes real
state. It prints the participant links, once. Each run creates a **new**
decision — credentials cannot be re-derived from their hashes, so there is no
way to re-print an earlier run's links, and seeding twice gives you a second
decision rather than a second copy of the first.

The scenario (`scripts/seed.ts`) is a decision two days into Discuss: three
people invited, two who submitted and disagree, ten backdated messages, and a
disagreement resting on something neither of them has said out loud. The third
participant has never opened their link — so opening it is a **first visit**,
and what they get is a Current State Brief of an argument already in progress.

### Opening a link

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
There is no deadline; the discussion runs until the owner closes the decision.

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

## The board

The participant-facing board is exactly three things:

```text
Current Positions
Cruxes
Action Items
```

It is projected on every read — positions from `current_positions`, the rest
from the facilitator's state. There is no board table: a stored board is a
board that can disagree with the decision it describes. Participants cannot
edit board items; the way to change the board is to say something.

Assumptions and conflicts are deliberately *not* on it. The facilitator
maintains more than it exposes: an inferred assumption is a hypothesis about
somebody, and a list of them presented as a board reads as a verdict on how the
team is thinking. They reach participants as questions in the discussion, and
the challenged ones in the brief.

## Changing position

A current position is the participant's own to state. The facilitator applies a
change only when someone has said, in so many words, that they are changing it:

```text
explicit === true    →  the current position moves
anything else        →  nothing happens
```

Reasoning that evolves, a concession, an argument that now looks weaker — none
of those is a position change, and an inferred one is dropped twice: by the
validator, and again by the Agent, which is the authority over what may touch a
position.

If an explicit change names a new option but no confidence, the confidence is
cleared rather than carried over from the option they have just left, and the
facilitator asks for it — once, deterministically, not when the model
remembers to. The question is tracked as a pending request and closes when the
participant answers, which they do by saying the number in the discussion like
anything else. A participant who never submitted can acquire a position this
way; their initial submission stays absent, because a current position is not a
submission.

## Intervening selectively

Observe continuously, intervene selectively. The hard half is not deciding
whether the facilitator has something to say — it usually does — but whether
saying it again tells the team anything.

Each intervention carries an **issue key**: the model's own identifier for the
underlying issue, reused across analyses even when it would now word the issue
differently. Each one is stored with a **digest of what the decision materially
consisted of** when it was made — every assumption, crux and conflict with its
status, and every current position. An issue already raised is raised again
only if that digest has since moved:

```text
message          the facilitator's reading        outcome
─────────────────────────────────────────────────────────────
A                new issue identified             intervenes
B (same ground)  identical reading                silent
C (new evidence) assumption now CHALLENGED        intervenes
```

Silence at B does not depend on how the intervention is worded — a re-worded
intervention about an unchanged reading is exactly what a repeat looks like in
practice, and is precisely what the digest catches and a string comparison does
not. A verbatim check remains as a backstop for the same issue arriving under a
freshly invented key.

**Open assumptions are deliberately excluded from the digest**, and that
exclusion is the difference between a gate that closes and one that does not.
The facilitator adds open assumptions constantly — every message gives it
another — so a digest that counted them moved on every analysis, and an issue
raised once could be raised again one message later. It did: end-to-end, the
facilitator asked about the same unquantified cost twice in three messages,
under the same issue key, with the digest growing from 1578 to 1634 characters
between them. What the digest tracks now is what a participant would call a
development — the board, where anybody's position stands, and the assumptions
whose standing has changed. An assumption challenged, refuted or agreed is a
thing that happened; one merely noticed is not.

Its known ceiling: the digest covers the whole facilitator model rather than
the part belonging to one issue, so an unrelated *material* development
elsewhere can re-open an issue that has not itself moved. Linking each issue to
the state it rests on would mean trusting the model to maintain that link
across analyses, which is a great deal more than trusting it with an
identifier.

## The Current State Brief

Opening a decision produces a brief: where it stands on a first visit, and what
has moved since **the last time this participant opened it** — not since the
last message — on a returning one. Reading the brief *is* the visit, so it is
read once per opening rather than on every realtime update; a brief re-read on
every projection change would reset its own boundary and have nothing to report
ever again.

It is composed from authoritative state rather than written by the model. A
generated summary of a disagreement is one sentence away from being an argument
about it, and a participant who reads "the case for slipping has grown" has
been recommended an option by a facilitator that is not allowed to recommend
one. Counting what changed cannot do that, arrives instantly, needs no
Workflow, and cannot be stale. The facilitator's judgement still reaches the
participant here — the cruxes, the challenged assumptions and the questions are
all its reading of the discussion. What is deterministic is the summarising.

Before the Reveal the brief says how many have submitted and nothing about what
they submitted.

## Closing

The owner declares the outcome and closes the decision. The status and the
outcome move in one statement inside one transaction, so there is no instant at
which a decision is `CLOSED` without the outcome its owner declared — the
invariant the transaction exists for. The facilitator has no say in it: closing
takes the outcome as an argument, and there is no code path by which a model
could supply one.

Before closing, the owner reads a **closing advisory** — the unresolved cruxes
and conflicts, the assumptions the discussion challenged or refuted, and
whether the team ever converged. It is composed from state the facilitator
already holds, so it introduces nothing, and it is a separate read from the
close: the owner has to be able to see the warning and close anyway. Nothing in
it reaches the close transaction, so there is no path by which an open crux
could delay a closure. It is also the only place assumptions and conflicts
leave the Agent for a screen — the board deliberately shows neither.

Dissent, in the advisory, is every held position when the team holds more than
one — never a minority. Which side is the minority is exactly what this product
must not point at.

Once closed the decision is read-only: no messages, no submissions, no second
reveal, no reopen. An analysis whose inference finished *after* the close
commits lands nothing at all — not a crux, not an intervention, not a position
change. Committed order decides, the same way it decides a message racing a
close, and the Durable Object's single thread is what establishes it. There is
no lock.

### The closing memo

Closing schedules a short-lived Workflow that writes a memo around the outcome.
The memo carries the outcome only so the Agent can refuse one that disagrees:
it is copied from the closed decision, and the model is never asked for it, so
"the facilitator never chooses the outcome" is a shape rather than a rule
something has to check.

Its list fields are *selections*, not compositions. The prompt hands the model
the exact statements the facilitator recorded — the challenged and refuted
assumptions, the open cruxes and conflicts, the commitments — and asks it to
copy across the ones that belong in the record. Each string that comes back is
matched against that set and dropped if it matches nothing, so the memo can
lose an item but cannot gain one. The model's judgement is *which* of them
mattered; that judgement is why it is asked at all.

`dissent` has no list to copy from — who still disagreed is a reading of the
discussion, not a row in the working model — so it is grounded against the
final positions instead. A team whose positions agreed has no dissent to
report, whatever the model wrote; each line must name a participant who is
holding one of the positions the team split across; and a line that puts a
named participant on an option they did not end up holding is dropped, because
an invented disagreement in the permanent record is worse than a missing one.
Only options somebody actually holds are checked, so a label like "Other" that
nobody ended on does not become a word the memo may not contain.

`reasoning` is the one field with no deterministic grounding, and that is an
accepted limitation rather than an oversight — see
[Grounding limitation](#grounding-limitation-intentional-mvp) below.

One function builds the known lists for both the prompt and the validator, so
the model is never asked for something it would then be penalised for giving.

The memo row is written by the close transaction itself, as `PENDING`, so a
closed decision says immediately that a memo is coming — a synthesis that never
arrives then reads as one that failed rather than as one nobody asked for. It
goes to `READY` once and nothing afterwards may overwrite it: a retried
Workflow step, a duplicate instance, or a failure report arriving late all find
a memo already there and leave it alone. A failure leaves the decision closed
and the outcome exactly as declared.

The projection gains one field, `closingMemoStatus`, and it is a signal rather
than content: a browser that watches it move from `PENDING` to `READY` re-reads
the decision and finds the memo waiting. The memo itself never rides on the
broadcast. It is deliberately *not* the existing `facilitatorStatus` — a
discussion analysis can legitimately still be in flight when the owner closes,
and the two are unrelated processes that must not share a slot.

### Team history

Once the memo is committed, the Workflow's last step files the closed decision
in the `TeamAgent`: the question, the outcome by label, the memo, and the
**significant learnings** — the assumptions the discussion challenged or
refuted. Those are derived from authoritative facilitator state rather than
taken from the memo: the memo is the model's account of the decision, and what
the team carries forward should not be.

The write is idempotent by decision id, because the step can be replayed after
it has already succeeded. The Team Agent is an archive, not an index: it has no
search, no ranking and no retrieval beyond reading one decision back by id, and
its read is a plain Durable Object RPC rather than a `@callable()` — it has no
participant or session model, so nothing it holds may reach a browser.

The MVP has one implicit team, addressed by the constant `DEFAULT_TEAM_ID`.
There is no team-creation path yet, so inventing team plumbing to support
closing would be building the container before anything can fill it. It stays
one implicit team: M7 introduced decision creation, not team creation, and the
single-team limitation is a documented MVP limitation rather than a gap M7
closed.

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
| Latency per analysis | 17–20s | 25–70s |

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

M5 re-ran it against the wider response the milestone asks the model for, and
found one thing: at 4096 tokens a run was **truncated mid-array**, which is not
a shorter analysis but invalid JSON. The budget is now 8192, and three runs
score 97% recall, 93% attribution, both implicit conflicts in two runs of
three, valid output in 3 of 3, and no inferred position changes. The model
selection stands; nothing about it was re-opened.

M5 added one criterion: **no inferred position changes.** Nobody in the
transcript changes position — Priya says in so many words that she has not — so
every change reported against it is one the model inferred, and an inferred
change is the one kind of model error that would rewrite a participant's stated
position for them.

## End-to-end verification

The runtime tests prove the Agent's rules against analyses handed in by hand.
`scripts/verify.ts` proves the same rules with a real model attached, by being
a second participant:

```bash
npm run dev                                     # in another terminal
npm run seed -- http://localhost:5173           # or, for an empty decision:
node scripts/verify.ts frame "…" "Ada,Grace" "Option A,Option B"
node scripts/verify.ts submit <link> opt-2 3 "…"
node scripts/verify.ts say    <link> "…"        # posts, waits for the facilitator
node scripts/verify.ts state  <link>
node scripts/verify.ts watch  <link> 90         # every push, unprompted
node scripts/verify.ts advise <link>            # the owner's pre-close warning
node scripts/verify.ts close  <link> opt-1      # declares the outcome, waits
                                                # for the closing memo
node scripts/verify.ts history <decisionId>     # what the Team Agent kept
```

It speaks the Agents SDK's RPC frames over its own WebSocket with its own
cookie jar, which is what makes it a genuinely separate participant: the
session cookie is named per decision, so two people in one decision cannot
share a browser profile. Open the other participant's link in a browser and
the pair covers the whole loop — reveal, analysis, board, a realtime update
arriving somewhere it was not caused, a position change, the confidence
follow-up, selectivity, refresh, the returning brief, and then the close: the
advisory, the declared outcome, the memo landing on the other participant's
screen without a refresh, and the closed decision refusing everything.

`frame` creates its decision through `POST /admin/decisions`, so it needs
`SEED_TOKEN` — it is read from `.env`. Every other command works from a
participant link alone, including links printed by `npm run seed`, because a
link carries its own origin. `VERIFY_ORIGIN` points `frame` and `history` at a
deployment instead of the dev server:

```bash
VERIFY_ORIGIN=https://<your-worker>.workers.dev node scripts/verify.ts frame …
```

`history` is the exception that stays local. It reads the Team Agent back over
the wire through a development-only route, guarded by `import.meta.env.DEV` —
eliminated from the deployed Worker rather than merely refused there. It is
verification infrastructure, not a product API, and the Team Agent has no
participant or session model to expose one safely. On a deployed instance the
closing memo reaching `READY` is the observable signal; the history write is
the same Workflow step.

Two defects were found this way and neither was visible to the tests: the
intervention gate did not close in a live discussion (above), and a position
change stated in a participant's own words rather than in the option's exact
label was not reported at all, so a stated position was silently lost. Both are
fixed, and both now have a test.

## Prerequisites

- Node.js ≥ 22.18 (the scripts are TypeScript run directly by Node's built-in
  type stripping — there is no `tsx`/`ts-node` dependency)
- A Cloudflare account, an API token, and the Account ID

## Setup

```bash
npm install
cp .env.example .env    # CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, SEED_TOKEN
npm run setup
```

`SEED_TOKEN` is yours to choose — `openssl rand -hex 32`. It is the operator
token for `POST /admin/decisions`; see "Creating a decision, and opening it".

`npm run setup` validates the credentials, generates Worker types, builds,
deploys — uploading `SEED_TOKEN` as a Worker secret with the deploy, because a
Worker that does not exist yet cannot be given a secret in advance — then seeds
a decision into the deployment it just made and prints the participant links
and the application URL.

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
| `npm run setup` | Validate → types → build → deploy → seed → print links |
| `npm run seed` | `npm run seed -- <origin>` — seed a decision into that deployment |
| `npm test` | Tests — both projects |
| `npm run test:unit` | Pure domain and script tests, in Node |
| `npm run test:agents` | Agent tests, in the real Workers runtime |
| `npm run eval` | Facilitator model evaluation (needs Cloudflare credentials) |
| `npm run types` | Regenerate `env.d.ts` from `wrangler.jsonc` |
| `npm run check` | Typecheck |

## Tests

Two Vitest projects, because the suites need different runtimes.

`test/unit` is plain Node: pure domain rules (submission and message
validation, the authorization table, the closing advisory and its notion of
dissent), the facilitator's output validators for both an analysis and a
closing memo, and the Node-side setup script.

`test/agents` runs **inside workerd**, via `@cloudflare/vitest-pool-workers`,
against a real Durable Object and its real SQLite. Atomicity, Durable Object
serialization, race determinism and post-commit Workflow scheduling are claims
about the runtime, so they are tested in it rather than against a stand-in. The
`FacilitatorWorkflow` is the one thing doubled: the tests drive the Agent side
of the boundary directly — claiming and releasing the analysis slot, applying,
refusing a stale result, rolling back a bad one, closing atomically, refusing
an analysis that arrives after the close, committing a memo once — while
`npm run eval` covers the model itself. Neither project needs Cloudflare credentials: the pool runs
with remote bindings off, which is also why the model is not called from a
test.

**Requires npm ≥ 11.** npm 10.9.8 crashes (`Cannot read properties of null
(reading 'edgesOut')`) resolving Vitest 4's optional peer graph, which
`@cloudflare/vitest-pool-workers` requires. `npm ci` from the committed
lockfile is unaffected; a fresh `npm install` on npm 10 is not.

## Grounding limitation (intentional, MVP)

**The system provides prompt-level grounding for free-form reasoning; it does
not guarantee deterministic factual grounding of every sentence.**

Everything the facilitator writes into durable state as a *list* is validated
deterministically. An assumption, crux, conflict, action item or position
change is matched back against the decision's own participants and options, and
the closing memo's lists are selections from statements the facilitator already
recorded. Dissent is grounded against the final positions. None of it can name
somebody who is not here or an option nobody holds.

Two fields are prose, and prose is not checkable that way: the closing memo's
`reasoning`, and the facilitator's intervention message. What stands behind
them is the prompt, the structured-output schema, and the model evaluation —
not a validator. A sentence of `reasoning` that characterises the discussion
slightly wrongly would be written into the permanent record.

This is a deliberate boundary. Validating prose sentence by sentence means a
second model judging the first one, which is not deterministic validation — it
is another untrusted output in the same position, with the same failure mode
and one more thing to be wrong. The cost of the boundary is bounded by what
`reasoning` is allowed to be: a summary that sits beside the outcome, the
lists and the transcript, all of which *are* grounded, and any of which a
reader can check it against.

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

`SEED_TOKEN` is a bearer credential too, and a stronger one: it creates
decisions. It is a Worker secret, is compared as a hash of itself so a near-miss
costs an attacker no more than a wild guess, and is never logged, echoed, or
sent to a browser. Treat it the way you would a deploy key. Nothing it protects
is readable — the administrative surface is one creation operation, with no way
to list, read, or delete anything.
