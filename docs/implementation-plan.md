# Async Decision Facilitator
## Repo-Level Implementation Plan

## 1. Purpose

This document translates the product requirements and technical design into a sequence of bounded implementation milestones.

The implementation is intentionally incremental. Each milestone produces a runnable, testable artifact before the next milestone begins.

The architecture is established by the requirements and technical design; implementation agents should not independently redesign it.

The implementation plan is expected to evolve as implementation reveals new information. When implementation uncovers a technical constraint, Cloudflare platform behavior, or a better implementation approach that materially affects the architecture or subsequent milestones, the finding should be reported and incorporated into this plan before proceeding.

---

# 2. Implementation principles

### 2.1 The architecture is decided before coding

The following architectural decisions are fixed unless implementation evidence demonstrates that they are infeasible:

- Decision Agent is the single transactional authority for active decision state.
- Team Agent owns closed decision history.
- Both are SQLite-backed Durable Objects.
- AI processing is asynchronous and durable.
- Participant operations never depend on successful AI execution.
- Workflow coordinates AI processing but does not own decision state.
- Agents SDK provides the application backend/RPC and realtime synchronization.
- Worker remains thin.
- Workers AI is the initial model runtime.
- There is no conventional REST API unless a concrete platform requirement emerges.
- Board state is a projection, not a generic persistence model.
- Participant identity is based on persistent bearer credentials.
- Current participant position is authoritative over initial submission.

### 2.2 Keep Cloudflare interaction programmatic

The desired developer experience is:

```text
Create Cloudflare credentials once
        ↓
npm run setup
        ↓
deploy + provision + seed
        ↓
application is usable
```

Manual Cloudflare dashboard configuration should be minimized.

The repository should declaratively configure Cloudflare resources through Wrangler wherever possible.

Do not introduce custom Cloudflare provisioning APIs unless Wrangler cannot express a required configuration.

### 2.3 AI is an untrusted dependency

LLM output must never be trusted simply because it conforms to the expected prompt.

AI output must pass:

1. parsing
2. schema validation
3. semantic validation
4. transactional application

Malformed or unsafe AI output must fail without corrupting decision state.

### 2.4 Agents own state; Workflows own execution

Decision Agent:

```text
authoritative state
transactions
permissions
realtime projection
AI scheduling/coalescing
```

Workflow:

```text
durable AI execution
retry
model invocation
output validation
```

Workflow does not become the system of record.

### 2.5 No silent scope expansion

Do not add:

- accounts
- email
- notifications
- general AI coaching
- recommendations
- presence
- nested conversations
- evidence/provenance UI
- sophisticated history/search
- post-close action tracking
- deadlines
- voice
- mobile-specific behavior
- integrations

unless explicitly added to the requirements.

---

# 3. Agent execution protocol

Each milestone is intended to be handed to a separate coding agent.

The agent receives:

1. the requirements document
2. this implementation plan
3. the specific milestone below

The agent should implement only that milestone.

## At the beginning of a milestone

The agent should:

- inspect the existing repository
- inspect the implementation already completed
- identify relevant existing contracts
- confirm the milestone's assumptions
- avoid rewriting completed work unnecessarily

## During implementation

The agent should:

- preserve established interfaces unless there is a compelling reason to change them
- write tests for important behavior
- prefer simple implementations
- avoid speculative abstractions
- document meaningful discoveries
- avoid introducing dependencies without justification

## When implementation reveals new information

The agent should distinguish:

### Local implementation discovery

Example:

> Wrangler requires a slightly different configuration syntax than initially expected.

The agent may resolve this locally and report it.

### Contract change

Example:

> The Agents SDK cannot support the proposed authentication mechanism.

The agent should stop before silently changing the architecture and report:

- what was discovered
- why the existing plan doesn't work
- proposed alternative
- affected milestones
- tradeoffs

The implementation plan is then updated before dependent work proceeds.

## At milestone completion

The agent should report:

```text
Implementation summary
Files added/changed
Tests added
Tests run
Deployment verification
Important discoveries
Deviations from plan
Recommended changes to future milestones
Known limitations
```

This report becomes input to the next planning iteration.

---

# 4. Milestone overview

| Milestone | Objective | Exit condition |
|---|---|---|
| M0 | Cloudflare-as-code setup | One-command deployment works |
| M1 | Application spine | Real Decision Agent can bootstrap a decision |
| M2 | Decision lifecycle | Frame → Submit → Reveal works |
| M3 | Discussion | Realtime chronological discussion works |
| M4 | Facilitator foundation | AI can analyze Reveal/discussion safely |
| M5 | Decision intelligence | Board, cruxes, position changes, brief work |
| M6 | Closing + history | Owner closes and Team Agent stores result |
| M7 | Seeded demo | Fresh deployment is immediately demonstrable |
| M8 | Hardening | Tests, model evaluation, failure handling, README complete |

The milestones deliberately put infrastructure and the application spine first, before substantial AI or UI work.

---

# M0 — Cloudflare-as-Code Setup

## Objective

Prove that the project can be deployed with minimal human interaction with the Cloudflare dashboard.

## Human setup

The user should need only:

- a Cloudflare account
- a Cloudflare API token
- the Cloudflare Account ID

The exact minimum token permissions should be verified against actual deployment behavior rather than guessed.

## Repository responsibilities

Create:

```text
wrangler.jsonc
.env.example
scripts/setup.ts
package.json
```

Configure:

- Worker
- static assets
- DecisionAgent Durable Object
- TeamAgent Durable Object
- SQLite storage
- Facilitator Workflow
- Workers AI binding
- required compatibility settings
- observability where appropriate

## `npm` interface

Provide:

```bash
npm run dev
npm run build
npm run deploy
npm run setup
npm run seed
npm test
npm run eval
npm run types
```

The normal fresh-install path is:

```bash
npm install
cp .env.example .env
# add Cloudflare credentials
npm run setup
```

## `setup.ts`

The setup process should:

1. validate required environment variables
2. validate Cloudflare authentication
3. generate types if necessary
4. build
5. deploy
6. seed the demonstration scenario
7. print application/demo URLs

It should not manually create Cloudflare resources through REST APIs unless Wrangler cannot provision something required.

## Acceptance criteria

A fresh developer can:

```bash
npm install
npm run setup
```

and obtain a deployed application without manually creating:

- Workers
- Durable Object namespaces
- SQLite databases
- Workflows
- Workers AI bindings

in the dashboard.

## Important discovery to capture

Record the actual minimum Cloudflare API token permissions required.

---

# M1 — Application Spine

## Objective

Establish the fundamental application path:

```text
Browser
  ↓
Worker
  ↓
authenticated session
  ↓
DecisionAgent
  ↓
SQLite
  ↓
RPC
  ↓
React
```

No meaningful product behavior or AI is required yet.

## Repository

Create:

```text
src/server/index.ts
src/server/agents/decision.ts
src/server/agents/team.ts
src/server/auth/credentials.ts
src/server/auth/sessions.ts
src/server/db/decision-schema.ts
src/shared/types.ts
```

## Shared domain contracts

Implement the established domain types:

- Decision
- Participant
- InitialSubmission
- CurrentPosition
- Message
- facilitator state types
- BoardView
- StateBrief
- Permissions
- DecisionBootstrap
- FacilitatorContext
- FacilitatorAnalysisResult
- ClosingMemo

Do not duplicate these contracts in the frontend or AI layer.

## SQLite

Implement the authoritative Decision Agent schema:

```text
decisions
participants
initial_submissions
current_positions
messages
facilitator_assumptions
facilitator_cruxes
facilitator_conflicts
facilitator_action_items
facilitator_meta
pending_participant_requests
```

Do not create a generic `board_items` table.

## Authentication

Support:

```text
/d/:decisionId/p/:credential
```

The Worker validates the persistent participant credential through the Decision Agent and establishes a browser-local HTTP-only session.

The persistent credential remains reusable across browsers/devices.

Only credential hashes are persisted.

## Decision Agent

Implement:

```ts
@callable()
getBootstrap()
```

The initial implementation should return the real persisted decision state.

## Frontend

Implement the minimum React shell:

```text
src/client/main.tsx
src/client/app/App.tsx
src/client/hooks/useDecisionAgent.ts
```

Render:

- question
- context
- status
- participants
- basic decision state

## Acceptance criteria

A seeded or manually created decision can be opened through its participant link.

The application:

- authenticates the participant
- establishes a session
- connects to the Decision Agent
- reads SQLite-backed state
- renders the decision
- survives refresh
- works when the same persistent link is opened from another browser

No AI is required.

---

# M2 — Frame → Submit → Reveal

## Objective

Implement the core decision lifecycle through Reveal.

## Implement

```text
submitInitialPosition()
declareSubmissionsComplete()
revealDecision()
```

## Submission rules

Validate transactionally:

- status is `SUBMIT`
- participant has not already submitted
- option exists
- confidence is 1–5
- no more than three reasons

Initial submission is immutable.

## Automatic reveal

When the final invited participant submits:

```text
SUBMIT → DISCUSS
```

## Owner reveal

The owner may declare submissions complete at any time during Submit.

This invokes the same reveal path.

## Reveal transaction

Atomically:

- change status
- set `revealed_at`
- initialize current positions
- give non-submitters null position/confidence

After commit, schedule Reveal AI processing.

AI failure must not roll back Reveal.

## Acceptance criteria

Test:

- successful submission
- duplicate submission rejection
- invalid option
- invalid confidence
- more than three reasons
- automatic reveal
- owner-forced reveal
- missing participant submission
- submission/reveal race

The application reaches Discuss even when one or more participants never submitted.

---

# M3 — Discussion + Realtime

## Objective

Implement the live discussion experience.

## Implement

```ts
postMessage()
```

Messages are:

- chronological
- immutable
- flat
- assigned canonical sequence numbers

No nested replies.

No message editing/deletion.

No explicit mentions.

## Realtime

Use the Agents SDK realtime state projection.

Maintain only small state:

```text
status
participantCount
submittedCount
messageCount
messagesVersion
positionsVersion
boardVersion
facilitatorStatus
lastActivityAt
```

Historical messages remain in SQLite.

## Concurrency

Decision Agent is the serialization boundary.

Test:

- simultaneous messages
- message vs close
- refresh during discussion
- reconnect
- multiple concurrent participants

## Acceptance criteria

Two browser sessions can participate simultaneously.

A message committed by one participant becomes visible to another without manual refresh.

A refresh reconstructs the complete discussion from authoritative state.

---

# M4 — Facilitator Foundation

## Objective

Introduce AI without making AI part of the transactional request path.

## Model evaluation first

Before building sophisticated facilitator behavior, run the scripted approximately 40-message transcript against the initial model.

Measure:

- ≥80% assumption identification
- correct attribution
- valid structured output
- at least one of two implicit conflicts detected
- no invented conflicts
- output reliability

If the model is inadequate, evaluate an alternative before proceeding.

## Facilitator pipeline

Implement:

```text
FacilitatorContext
    ↓
prompt
    ↓
Workers AI
    ↓
JSON parse
    ↓
schema validation
    ↓
semantic validation
    ↓
FacilitatorAnalysisResult
```

Create:

```text
src/server/facilitator/context.ts
src/server/facilitator/prompts/reveal.ts
src/server/facilitator/prompts/discussion.ts
src/server/facilitator/schemas.ts
src/server/facilitator/validation.ts
```

## Workflow

Implement:

```text
src/server/workflows/facilitator.ts
```

with:

```text
REVEAL
DISCUSSION
CLOSING
```

Workflow input contains only:

```ts
{
  decisionId,
  type
}
```

The Workflow retrieves current state from the Decision Agent.

It does not receive or own the transcript.

## Reveal processing

After Reveal:

```text
DecisionAgent
    ↓
Reveal Workflow
    ↓
LLM
    ↓
validated analysis
    ↓
DecisionAgent
```

## Discussion processing

Messages trigger asynchronous analysis.

Decision Agent maintains:

```text
analysisRunning
analysisPending
lastAnalyzedSequence
```

Only one discussion analysis runs at a time.

Messages arriving while analysis is running set `analysisPending`.

## Stale results

AI results include their analyzed sequence range.

Decision Agent rejects or ignores stale/duplicate results.

## Acceptance criteria

AI failure does not prevent:

- posting messages
- changing positions
- closing the decision

Malformed AI output does not corrupt state.

Facilitator messages do not recursively trigger facilitator analysis.

---

# M5 — Decision Intelligence

## Objective

Complete the facilitator behavior and participant-facing decision intelligence.

## Facilitator state

Implement application of:

- assumptions
- cruxes
- conflicts
- action items
- facilitator interventions

The facilitator maintains more internal state than the participant-facing board exposes.

## Board

User-facing board contains:

```text
Current Positions
Cruxes
Action Items
```

Current positions are projected from `current_positions`.

No generic board persistence table.

Participants cannot directly edit board items.

## Assumptions

Support:

```text
EXPLICIT
INFERRED
```

Inferred assumptions are hypotheses, not asserted facts.

They should be expressed as questions to the relevant participant.

Significant challenged/refuted assumptions are retained for team history.

## Conflicts

Conflicts remain internal facilitator state.

They may lead to:

- a crux
- an intervention
- further analysis

The facilitator must not manufacture conflicts.

## Interventions

Facilitator:

- observes continuously
- intervenes selectively
- remains neutral
- serves the collective decision
- does not recommend options
- does not coach participants generically
- may legitimately remain silent

Repeated interventions on unchanged issues should be avoided.

## Position changes

The facilitator may identify position changes, but only:

```text
explicit === true
```

may automatically update the current position.

Reasoning changes alone must not change position.

If an explicit position change omits confidence, the facilitator requests confidence.

## Current State Brief

Implement:

```ts
getCurrentStateBrief()
```

Support:

- first-visit orientation
- returning-visit meaningful changes
- current positions
- open cruxes
- questions needing response
- challenged assumptions
- action items

Last visit means last opening/view, not last message.

The brief must remain neutral.

## Acceptance criteria

The facilitator can:

- identify assumptions
- attribute them
- identify cruxes
- identify conflicts without inventing them
- intervene selectively
- maintain action items
- recognize explicit position changes
- avoid inferred position changes
- generate a neutral current-state brief

---

# M6 — Close + Team History

## Objective

Complete the decision lifecycle and persist institutional history.

## Close

Implement:

```ts
closeDecision({
  outcome
})
```

Transactionally:

```text
verify owner
verify DISCUSS
verify outcome
DISCUSS → CLOSED
```

There must never be a persistent `CLOSED` state without an owner-declared outcome.

## Closing Workflow

After close:

```text
Closing Workflow
    ↓
final Decision Agent state
    ↓
LLM
    ↓
validated ClosingMemo
```

The memo contains:

- decision
- reasoning
- refuted assumptions
- unresolved issues
- dissent
- action items

The facilitator may synthesize but cannot alter the owner-declared outcome.

## Team Agent

Implement:

```text
src/server/agents/team.ts
```

Store:

```ts
ClosedDecisionRecord
```

including significant historical learnings.

Team Agent stores only closed decision history, not active decision state.

## Acceptance criteria

Closing is atomic.

Closing cannot occur before Reveal.

Closed decisions are immutable.

Closing memo generation can fail without changing the declared outcome.

Completed decisions appear in Team Agent history.

---

# M7 — Seeded Demonstration

## Objective

Make the deployed application immediately demonstrable.

## Seed scenario

Create:

```text
src/seed/scenario.ts
scripts/seed.ts
```

Seed a normal decision already in:

```text
DISCUSS
```

with:

- owner
- existing participant(s)
- initial submissions
- current positions
- backdated discussion messages
- facilitator state

The scenario should contain meaningful disagreement and at least one useful crux.

## No demo mode

Do not introduce:

```text
demoMode
```

or special demo-only application behavior.

The seeded decision is simply an existing decision.

## Idempotency

Running:

```bash
npm run seed
```

multiple times should not create duplicate demo decisions.

## Acceptance criteria

A fresh deployment produces usable participant links.

A new participant opening the seeded decision receives the Current State Brief and can enter the live discussion.

The demonstration exercises the actual production code paths.

---

# M8 — Hardening, Evaluation, and Documentation

## Objective

Bring the implementation to take-home quality without turning it into a production system.

## Domain tests

Cover:

- lifecycle invariants
- authorization
- submission immutability
- position changes
- confidence handling
- close semantics
- projections

## Agent tests

Cover:

- authentication
- bootstrap
- submission
- reveal
- discussion
- concurrency
- persistence
- realtime projection

## Workflow tests

Cover:

- successful execution
- model failure
- malformed output
- schema validation
- semantic validation
- retry
- stale results
- coalescing

## E2E

Exercise:

```text
persistent link
→ brief
→ submit
→ reveal
→ discussion
→ facilitator intervention
→ position change
→ close
→ closing memo
→ team history
```

## Failure model

Verify that AI failures leave the application usable.

The application should tolerate:

- model failures
- non-deterministic output
- malformed structured output
- invalid facilitator observations
- stale workflow results
- workflow retry

## README

Document:

- product
- architecture
- data ownership
- lifecycle
- Cloudflare setup
- API token requirements
- one-command deployment
- authentication model
- bearer credential limitation
- AI failure model
- seeded scenario
- model evaluation
- local development
- known limitations
- AI-assisted development process

The security limitation must explicitly state that possession of a participant link grants the ability to act as that participant and that there is no account recovery.

---

# 5. Final repository structure

The expected end state is approximately:

```text
/
├── src/
│   ├── client/
│   │   ├── app/
│   │   │   ├── App.tsx
│   │   │   └── routes.tsx
│   │   ├── components/
│   │   │   ├── DecisionHeader.tsx
│   │   │   ├── StateBrief.tsx
│   │   │   ├── PositionBoard.tsx
│   │   │   ├── CruxList.tsx
│   │   │   ├── ActionItemList.tsx
│   │   │   ├── Discussion.tsx
│   │   │   ├── MessageComposer.tsx
│   │   │   ├── SubmissionForm.tsx
│   │   │   ├── OwnerControls.tsx
│   │   │   └── ConnectionStatus.tsx
│   │   ├── hooks/
│   │   │   └── useDecisionAgent.ts
│   │   └── main.tsx
│   │
│   ├── server/
│   │   ├── index.ts
│   │   ├── agents/
│   │   │   ├── decision.ts
│   │   │   └── team.ts
│   │   ├── auth/
│   │   │   ├── credentials.ts
│   │   │   └── sessions.ts
│   │   ├── db/
│   │   │   ├── decision-schema.ts
│   │   │   └── team-schema.ts
│   │   ├── domain/
│   │   │   ├── decisions.ts
│   │   │   ├── participants.ts
│   │   │   ├── submissions.ts
│   │   │   ├── positions.ts
│   │   │   ├── messages.ts
│   │   │   └── board.ts
│   │   ├── facilitator/
│   │   │   ├── context.ts
│   │   │   ├── prompts/
│   │   │   │   ├── reveal.ts
│   │   │   │   ├── discussion.ts
│   │   │   │   ├── brief.ts
│   │   │   │   └── closing.ts
│   │   │   ├── schemas.ts
│   │   │   └── validation.ts
│   │   └── workflows/
│   │       └── facilitator.ts
│   │
│   └── shared/
│       ├── types.ts
│       └── errors.ts
│
├── seed/
│   └── scenario.ts
├── scripts/
│   ├── setup.ts
│   └── seed.ts
├── evals/
│   ├── facilitator-transcript.ts
│   ├── facilitator-eval.ts
│   └── fixtures/
├── test/
│   ├── unit/
│   ├── agents/
│   ├── workflows/
│   └── e2e/
├── wrangler.jsonc
├── package.json
├── .env.example
└── README.md
```

The exact file structure may evolve if implementation demonstrates that another organization is materially cleaner. Such changes should be reported rather than made silently.

---

# 6. Definition of done

The project is complete when:

### Product

- A decision can be framed.
- Participants can privately submit positions.
- Reveal occurs automatically or by owner declaration.
- Participants can discuss asynchronously.
- Participants can explicitly change positions.
- Facilitator surfaces assumptions, conflicts, and cruxes.
- Facilitator intervenes selectively and neutrally.
- Board reflects useful current state.
- Current State Brief orients participants.
- Owner declares the final outcome.
- Closing memo synthesizes reasoning.
- Closed decision enters team history.

### Architecture

- Decision Agent is authoritative.
- Team Agent stores history.
- SQLite is authoritative persistence.
- Agent realtime state remains small.
- Workflows perform durable AI processing.
- AI never blocks participant operations.
- AI output is validated.
- Stale AI results cannot overwrite newer state.

### Deployment

A developer can deploy with minimal Cloudflare dashboard interaction:

```bash
npm install
npm run setup
```

### Demo

A fresh deployment contains a seeded decision that demonstrates the product's core value.

### Engineering quality

- Core invariants have tests.
- Concurrency behavior has been tested.
- AI failure has been tested.
- Model evaluation has been performed.
- README explains the architecture and intentional limitations.

---

# 7. Iteration protocol for the implementation plan

This document is intentionally a living engineering artifact.

After each milestone, the implementation result should be reviewed against the remaining milestones.

If the agent reports:

```text
new platform behavior
new dependency
API limitation
performance concern
security concern
architectural conflict
better implementation approach
```

then update this plan before starting the affected milestone.

The update should identify:

```text
What changed
Why it changed
Which architectural decision is affected
Which milestones are affected
What the new implementation contract is
```

Do not allow downstream coding agents to inherit contradictory instructions.

The latest version of this plan is authoritative.

---

# 8. AI-assisted development record

The implementation should preserve the prompts used to instruct coding agents.

The prompt history should include:

1. the requirements document
2. this implementation plan
3. the milestone-specific implementation prompt
4. any subsequent correction or architectural update provided to the agent

The purpose is to demonstrate that AI was used as an implementation partner under an explicit technical direction rather than as an autonomous architect.

The milestone reports and subsequent revisions to this implementation plan provide the record of how implementation discoveries changed the design.

A final submission should therefore be able to show:

```text
Requirements
    ↓
Implementation Plan
    ↓
M0 Prompt
    ↓
M0 Result / Discovery
    ↓
Updated Plan
    ↓
M1 Prompt
    ↓
M1 Result / Discovery
    ↓
...
```

This is the intended development history.