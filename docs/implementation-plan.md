# Async Decision Facilitator
## Repo-Level Implementation Plan — Revision 1.3

## Revision History

| Revision | Change |
|---|---|
| **1.0** | Initial repo-level implementation plan |
| **1.1** | Incorporated M1 findings; clarified decision creation, persisted lifecycle states, owner credential model, session persistence, and explicitly rejected a public `/d/new` product endpoint |
| **1.2** | Added minimum Workers-runtime integration testing to M2 so transactionality, Durable Object serialization, race determinism, and post-commit Workflow scheduling can be directly proven |
| **1.3** | Explicitly assigned the minimum submission/owner UI to M2. M2 now delivers the Submit → Reveal experience end-to-end in the browser; M3 owns the discussion UI and realtime discussion experience |

---

# 1. Purpose

This document translates the product requirements and technical design into a sequence of bounded implementation milestones.

The implementation is incremental. Each milestone produces a runnable, testable artifact before the next milestone begins.

The requirements document and this implementation plan constitute the primary design record for AI-assisted implementation.

Each milestone is intended to be executed by a separate coding agent. The agent receives:

1. the requirements document
2. this implementation plan
3. the milestone-specific instructions
4. relevant prior milestone findings

The implementation plan is a living artifact. It is revised when implementation reveals information that materially changes requirements, architecture, interfaces, testing strategy, or subsequent implementation work.

The latest revision is authoritative.

---

# 2. Implementation Principles

## 2.1 Architecture is established before coding

The following decisions are established unless implementation evidence demonstrates that they are infeasible:

- Decision Agent is the single transactional authority for active decision state.
- Team Agent owns closed decision history.
- Both are SQLite-backed Durable Objects.
- AI processing is asynchronous and durable.
- Participant operations never depend on successful AI execution.
- Workflow coordinates AI processing but does not own decision state.
- Agents SDK provides application backend/RPC and realtime synchronization.
- Worker remains thin.
- Workers AI is the initial model runtime.
- There is no conventional REST API unless a concrete platform requirement emerges.
- Board state is a projection, not a generic persistence model.
- Participant identity is based on persistent bearer credentials.
- Current participant position is authoritative over initial submission.
- Cloudflare infrastructure should be declaratively configured through Wrangler wherever possible.
- Manual Cloudflare dashboard interaction should be minimized.

## 2.2 Keep Cloudflare interaction programmatic

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

The repository should own infrastructure configuration through Wrangler.

Do not introduce custom Cloudflare provisioning APIs unless Wrangler cannot express a required configuration.

## 2.3 AI is an untrusted dependency

LLM output must pass:

1. parsing
2. schema validation
3. semantic validation
4. transactional application

Malformed or invalid AI output must not corrupt decision state.

## 2.4 Agents own state; Workflows own execution

Decision Agent owns:

- authoritative state
- transactions
- permissions
- realtime projection
- AI scheduling/coalescing

Workflow owns:

- durable AI execution
- retries
- model invocation
- output validation pipeline

Workflow does not become the system of record.

## 2.5 Runtime acceptance criteria must be directly provable

A milestone must not claim to prove behavior that can only be tested in a later runtime environment.

When an acceptance criterion concerns:

- Durable Object serialization
- SQLite transactionality
- Cloudflare runtime behavior
- Workflow scheduling
- post-commit behavior
- race determinism

the milestone must include the minimum runtime test infrastructure required to directly exercise that behavior.

Do not replace runtime verification with mocks or hand-rolled in-memory Durable Object or SQLite shims merely to satisfy an acceptance criterion.

Comprehensive test hardening may remain a later milestone, but required runtime infrastructure must exist when the behavior is first introduced.

## 2.6 Milestones should produce vertical slices

When a milestone introduces user-visible behavior, it should include the minimum client UI required to exercise that behavior end-to-end.

Later milestones own their own richer UX.

The goal is not to build the entire UI early; it is to avoid creating server functionality that cannot be exercised through the actual application.

## 2.7 No silent scope expansion

Do not add:

- accounts
- account recovery
- email
- notifications
- invitation management
- presence
- nested conversations
- message editing/deletion
- explicit mentions
- position-change history
- evidence/provenance UI
- general AI coaching
- AI recommendations
- sophisticated history/search
- post-close action tracking
- deadlines
- voice
- mobile-specific behavior
- file uploads
- integrations

unless explicitly added to the requirements.

---

# 3. Agent Execution Protocol

Each milestone is a bounded implementation assignment.

## Before implementation

The agent should:

- inspect the existing repository
- inspect completed implementation
- review the current plan
- identify relevant existing contracts
- verify milestone assumptions

The agent should not redesign completed architecture merely because another approach is personally preferred.

## During implementation

The agent should:

- preserve established interfaces
- write tests for important behavior
- prefer simple implementations
- avoid speculative abstractions
- avoid unnecessary dependencies
- document meaningful implementation discoveries
- distinguish implementation details from product/architecture changes

## When implementation reveals new information

### Local implementation discovery

The agent may resolve locally when the change does not materially affect requirements or architecture.

Example:

> A Cloudflare API requires a slightly different configuration syntax than anticipated.

The agent should implement the correction and report it.

### Contract or architecture change

If implementation reveals something that affects:

- requirements
- security model
- lifecycle semantics
- persistence model
- Agent/Workflow boundaries
- public API
- future milestone assumptions
- ability to directly prove an acceptance criterion

the agent should not silently redesign the system.

It should report:

```text
What was discovered
Why the existing plan is insufficient
Proposed alternative
Tradeoffs
Affected milestones
```

The plan is then revised before dependent work proceeds.

## Milestone completion report

Every agent should report:

```text
Implementation summary
Files added/changed
Tests added
Tests run
Deployment verification
Important discoveries
Deviations from plan
Rejected alternatives
Recommended changes to future milestones
Known limitations
```

---

# 4. Settled Decisions from M1

## 4.1 Decision creation is not currently a public product capability

M1 introduced:

```text
POST /d/new
```

to satisfy the practical need to create a decision.

This was rejected as a product capability.

There is currently no requirement for an unauthenticated public decision-creation endpoint.

For development and demonstration purposes, decisions may be created through seed/development tooling.

If a user-facing decision-creation experience is later desired, it must be explicitly added to the requirements and implementation plan.

### Rejected decision

Do not preserve `/d/new` as an undocumented public product API.

Do not allow later agents to assume that M1's temporary creation endpoint is part of the application contract.

---

## 4.2 Owner is a normal participant

The owner is represented by:

```text
Participant {
  role: "OWNER"
}
```

There is no separate Owner entity.

The owner receives one persistent participant credential/link.

That credential grants:

- normal participant capabilities
- owner-only capabilities

There is not a separate participant link plus owner link.

### Rejected decision

Do not introduce a second owner-specific credential.

---

## 4.3 Persistent credential and session are different concepts

The persistent participant link is the durable identity credential.

The browser session is temporary authentication state.

```text
Persistent participant link
        ↓
browser session cookie
        ↓
authenticated Agent interaction
```

The persistent link:

- does not expire automatically
- can be reused
- can establish sessions in different browsers/devices

The session:

- is browser-local
- may expire
- does not replace the persistent link

Losing the persistent link means there is no account-recovery mechanism.

A session store is an acceptable implementation detail.

---

## 4.4 Frame is conceptual, not persisted

The product lifecycle is described as:

```text
Frame → Submit → Discuss → Close
```

But `Frame` is the act of creating/configuring the decision.

The persisted decision state is:

```text
SUBMIT → DISCUSS → CLOSED
```

A newly created decision enters `SUBMIT`.

There is no persisted `FRAME` status.

### Rejected decision

Do not add `FRAME` to `DecisionStatus` merely to mirror the conceptual product lifecycle.

---

## 4.5 Cloudflare implementation details discovered in M1

The following M1 discoveries are accepted:

- static asset `ASSETS` binding is required for the chosen Worker/SPA routing approach
- TypeScript target is ES2021 because ES2022 class-field semantics caused runtime issues with `@callable()`
- session resolution may occur inside the Agent because the Agent owns session state
- session cookie names may be decision-specific
- permission calculation belongs in testable domain code
- bootstrap should expose only state that the current milestone can actually provide

These are implementation decisions, not changes to product requirements.

---

# 5. Milestone Overview

| Milestone | Objective | Exit condition |
|---|---|---|
| **M0** | Cloudflare-as-code setup | One-command deployment works |
| **M1** | Application spine | Real Decision Agent can bootstrap a decision |
| **M2** | Decision lifecycle | Submit → Reveal works correctly, is directly runtime-tested, and can be exercised end-to-end through the browser |
| **M3** | Discussion | Realtime chronological discussion works |
| **M4** | Facilitator foundation | AI can analyze Reveal/discussion safely |
| **M5** | Decision intelligence | Board, cruxes, position changes, brief work |
| **M6** | Closing + history | Owner closes and Team Agent stores result |
| **M7** | Seeded demo | Fresh deployment is immediately demonstrable |
| **M8** | Hardening | Comprehensive tests, evaluation, failure handling, README complete |

---

# 6. M0 — Cloudflare-as-Code Setup

## Objective

Prove that the Cloudflare infrastructure can be declaratively configured and deployed with minimal dashboard interaction.

## Result

M0 is complete.

Direct evidence established:

- clean-clone installation works
- `npm ci` works from the committed lockfile
- type generation works
- typecheck works
- build works
- deployment dry-run works
- `npm run setup` deploys successfully
- deployed Worker returns HTTP 200
- Agent and Workflow bindings are provisioned
- no Cloudflare credentials are deployed to the Worker
- no credential leakage into build artifacts
- local development works

M0 intentionally did not establish that Durable Objects, SQLite, Workflows, or Workers AI execute correctly.

---

# 7. M1 — Application Spine

## Objective

Establish the fundamental runtime path:

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

## Result

M1 is complete.

M1 established:

- Decision Agent execution
- SQLite-backed Agent state
- participant authentication/session model
- bootstrap RPC
- React application shell
- Agent-native application interaction

M1 did not implement the decision lifecycle beyond establishing the initial state model.

---

# 8. M2 — Decision Lifecycle

## Objective

Implement and demonstrate the core:

```text
SUBMIT → DISCUSS
```

transition and establish the rules around initial submissions and Reveal.

M2 is also the first milestone that directly proves important runtime properties of the Durable Object implementation.

## Scope

Implement:

```ts
submitInitialPosition()
declareSubmissionsComplete()
revealDecision()
```

and the minimum client UI required to exercise those operations end-to-end.

## Submission UI

M2 includes:

```text
SubmissionForm.tsx
```

The participant must be able to:

- select an option
- select confidence from 1–5
- enter up to three reasons
- submit the initial position

The UI must reflect submission state and basic validation/errors.

The UI must not expose other participants' initial submissions before Reveal.

## Owner UI

M2 includes:

```text
OwnerControls.tsx
```

The owner must be able to:

- see that submissions are still pending
- declare submissions complete
- trigger the same server-side Reveal path as automatic Reveal

The control must only be available to the owner.

There is no separate owner credential.

## Reveal UI

After Reveal, the existing application shell must reflect:

```text
SUBMIT → DISCUSS
```

and display the now-visible current positions.

A participant who did not submit should remain represented without an initial/current position.

M2 does not implement the discussion UI itself.

M3 owns:

- discussion layout
- message rendering
- message composer
- realtime discussion UX
- connection state

## Submission rules

A participant may submit exactly once while the decision is in `SUBMIT`.

Validate transactionally:

- decision status is `SUBMIT`
- authenticated participant belongs to decision
- participant has not already submitted
- option exists
- confidence is an integer from 1–5
- no more than three reasons

Initial submissions are immutable.

A participant who has not submitted may not submit after Reveal.

## Automatic Reveal

After a successful initial submission, determine whether all invited participants have submitted.

If all have submitted:

```text
SUBMIT → DISCUSS
```

through the canonical `revealDecision()` path.

The transition must occur atomically.

## Owner-forced Reveal

The owner may declare submissions complete at any time while the decision is in `SUBMIT`.

Validate:

- authenticated participant is OWNER
- decision is in `SUBMIT`

Then invoke the same `revealDecision()` path used by automatic Reveal.

Do not create separate lifecycle logic for forced Reveal.

## Reveal transaction

Reveal must atomically:

1. change status from `SUBMIT` to `DISCUSS`
2. set `revealed_at`
3. initialize `current_positions` from submitted initial positions
4. leave missing submitters with no current position/confidence

Conceptually:

```text
submitted participant
    → current position initialized

non-submitting participant
    → current position remains null
```

The initial submission remains historical context.

## Post-Reveal behavior

After Reveal:

- no new initial submissions are accepted
- participants without initial submissions may still participate in discussion
- current positions become the authoritative participant position
- the facilitator may subsequently observe explicit position changes

## Reveal AI scheduling boundary

After the Reveal transaction commits:

```text
DecisionAgent
    ↓
Reveal Workflow
```

The AI operation must not be part of the Reveal transaction.

AI failure must not prevent the decision from entering `DISCUSS`.

The actual facilitator model invocation is M4.

M2 must establish and test the scheduling boundary without requiring a real LLM invocation.

## Runtime testing requirement

M2 must include the minimum Cloudflare Workers runtime test infrastructure necessary to directly exercise:

- real Decision Agent execution
- real Durable Object SQLite storage
- real Durable Object serialization
- transactionality
- concurrent lifecycle operations
- post-commit Workflow scheduling behavior

Use the Cloudflare-supported Workers Vitest runtime tooling (`@cloudflare/vitest-pool-workers`) or the equivalent runtime mechanism already established by the repository.

Do not use a hand-rolled in-memory SQLite or Durable Object shim to claim runtime correctness.

The runtime test harness is part of M2, not deferred to M8.

It is acceptable to use a test double for the Workflow itself when the purpose of the test is to prove that the Decision Agent schedules the Workflow only after commit.

The test must nevertheless execute the Decision Agent in the actual Workers runtime.

## Required race tests

At minimum, directly test:

### Final submission vs. owner force-reveal

Whichever transaction commits first determines the Reveal boundary.

### Submission vs. Reveal

A submission that commits after Reveal is rejected.

### Duplicate submission

Only one initial submission may exist for a participant.

### Reveal transaction failure

A failed operation before commit must not leave a partially transitioned decision.

## Required scheduling test

Prove:

```text
successful Reveal transaction
        ↓
commit
        ↓
schedule Reveal Workflow
```

rather than:

```text
schedule Workflow
        ↓
attempt Reveal transaction
```

The test should establish that a failed Reveal transaction does not schedule the AI job.

## Required AI-failure boundary test

M2 does not need to invoke a real Workers AI model.

Instead, establish the application boundary such that a failure in the post-Reveal AI processing path cannot roll back the already-committed:

```text
SUBMIT → DISCUSS
```

transition.

The test should demonstrate:

```text
Reveal committed
        ↓
AI/Workflow failure
        ↓
decision remains DISCUSS
```

## Authorization

Participant:

- may submit own initial position
- may not submit for another participant

Owner:

- all participant permissions
- may declare submissions complete

No separate owner credential is introduced.

## Acceptance criteria

M2 is complete when:

### Browser experience

- a participant can complete an initial submission through the browser UI
- submission UI enforces the basic input constraints
- an owner can declare submissions complete through the browser UI
- automatic Reveal is observable through the browser
- owner-forced Reveal is observable through the browser
- after Reveal, current positions are visible
- non-submitters remain without a position
- no initial submissions are exposed before Reveal

### Domain behavior

- valid initial submission
- duplicate submission rejection
- invalid option rejection
- invalid confidence rejection
- more than three reasons rejected
- automatic Reveal
- owner-forced Reveal
- missing submission does not prevent forced Reveal
- initial submissions become immutable after Reveal
- current positions initialize correctly
- non-submitters can participate after Reveal

### Runtime behavior

- Decision Agent executes in the Workers runtime
- SQLite persistence works in the real Durable Object
- Durable Object serialization is exercised directly
- concurrent lifecycle operations behave deterministically
- submission/Reveal races have deterministic outcomes
- Reveal is atomic
- AI scheduling occurs only after successful Reveal commit
- a failed Reveal does not schedule AI processing
- failure in post-Reveal AI processing does not roll back Reveal

## Explicit non-goals

M2 does not implement:

- discussion layout
- discussion message composer
- realtime discussion UX
- facilitator reasoning
- facilitator interventions
- crux detection
- conflict detection
- Current State Brief
- closing
- Team history
- position changes
- actual Workers AI inference
- substantive discussion AI

---

# 9. M3 — Discussion + Realtime

## Objective

Implement the live asynchronous discussion experience.

M3 builds directly on the Discuss state produced by M2.

## Message model

Messages are:

- chronological
- immutable
- flat
- assigned canonical sequence numbers

No:

- nested replies
- editing
- deletion
- explicit mentions

## `postMessage()`

The operation:

1. authenticates participant
2. verifies `DISCUSS`
3. validates message
4. allocates sequence
5. inserts message
6. commits
7. updates realtime projection
8. schedules facilitator analysis

AI is not part of the message transaction.

## Client UI

Implement:

```text
Discussion.tsx
MessageComposer.tsx
ConnectionStatus.tsx
```

The discussion UI must:

- display chronological messages
- distinguish participant and facilitator messages
- allow authenticated participants to post
- reflect connection state
- update without manual refresh

## Realtime

Use Agents SDK realtime state synchronization.

Maintain only small projection state:

```ts
interface DecisionRealtimeState {
  status: DecisionStatus;
  participantCount: number;
  submittedCount: number;
  messageCount: number;
  messagesVersion: number;
  positionsVersion: number;
  boardVersion: number;
  facilitatorStatus: FacilitatorStatus;
  lastActivityAt: number | null;
}
```

Historical messages remain in SQLite.

## Concurrency

Decision Agent is the serialization boundary.

Test:

- simultaneous messages
- message vs. close
- refresh during discussion
- reconnect
- multiple concurrent participants

## Acceptance criteria

Two browser sessions can participate simultaneously.

A committed message becomes visible to other participants without manual refresh.

A refresh reconstructs discussion from authoritative SQLite state.

---

# 10. M4 — Facilitator Foundation

## Objective

Introduce AI safely and prove the model is adequate before substantial facilitator implementation.

## Model evaluation

Before full facilitator implementation, run the scripted approximately 40-message transcript.

Measure:

- ≥80% assumption identification
- correct participant attribution
- valid structured output
- detection of at least one of two implicit conflicts
- no invented conflicts
- reliable output formatting

If the initial Llama 3.3 model is inadequate, evaluate another model before continuing.

Verify actual Workers AI inference and resolve the remaining model-binding/permission question from M0/M1.

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

## Workflow

Implement:

```text
REVEAL
DISCUSSION
CLOSING
```

Workflow input:

```ts
interface FacilitatorWorkflowInput {
  decisionId: string;
  type: FacilitatorWorkflowType;
}
```

The Workflow retrieves current state from Decision Agent.

It does not receive or own the transcript.

## Discussion coalescing

Decision Agent maintains:

```text
analysisRunning
analysisPending
lastAnalyzedSequence
```

Only one discussion analysis runs at a time.

Messages arriving during analysis set `analysisPending`.

When the current analysis completes, newly arrived messages are processed.

## Stale results

AI results include the sequence range they analyzed.

Decision Agent rejects or ignores stale/duplicate results.

## Acceptance criteria

AI failure does not prevent:

- posting messages
- continuing discussion
- changing positions
- closing the decision

Malformed AI output cannot corrupt application state.

Facilitator messages do not recursively trigger facilitator analysis.

---

# 11. M5 — Decision Intelligence

## Objective

Complete the participant-facing decision intelligence.

## Facilitator state

Implement:

- assumptions
- cruxes
- conflicts
- action items
- interventions

The facilitator maintains more state internally than it exposes to participants.

## Board

The participant-facing board contains:

```text
Current Positions
Cruxes
Action Items
```

Current Positions are projected from `current_positions`.

No generic board table is introduced.

Participants cannot directly edit board items.

## Assumptions

Support:

```text
EXPLICIT
INFERRED
```

Inferred assumptions are hypotheses.

They must be phrased as questions to the relevant participant rather than asserted as facts.

Significant challenged/refuted assumptions are eligible for Team Agent history.

## Conflicts

Conflicts remain internal facilitator state.

A conflict may lead to:

- a crux
- an intervention
- further analysis

The facilitator must not manufacture conflicts.

## Interventions

The facilitator:

- observes continuously
- intervenes selectively
- remains neutral
- serves the collective decision
- does not recommend options
- does not provide generic reasoning coaching
- may legitimately remain silent

The facilitator should not repeat an intervention when the underlying issue has not materially changed.

## Position changes

The facilitator may identify position changes.

Only:

```text
explicit === true
```

may change current position automatically.

Reasoning changes alone do not change position.

If an explicit position change omits confidence, the facilitator asks for confidence.

## Current State Brief

Implement:

```ts
getCurrentStateBrief()
```

Support:

- first-visit orientation
- returning-visit summary of meaningful changes
- current positions
- open cruxes
- questions needing response
- challenged assumptions
- action items

Last visit means the participant's last opening/view, not the last message.

The brief is neutral and must not become an implicit recommendation system.

---

# 12. M6 — Close + Team History

## Objective

Complete the decision lifecycle and persist institutional history.

## Close

Implement:

```ts
closeDecision({
  outcome
})
```

Transaction:

```text
verify OWNER
verify DISCUSS
verify outcome
DISCUSS → CLOSED
```

There must never be a persistent CLOSED decision without an owner-declared outcome.

The outcome is selected/declared by the owner.

The facilitator never selects or infers the outcome.

## Closing Workflow

After the close transaction commits:

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

The memo may synthesize existing reasoning but must not invent facts or recommendations.

The owner-declared outcome remains authoritative.

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

Team Agent stores closed history only.

## Acceptance criteria

- close is atomic
- only owner can close
- close requires DISCUSS
- outcome is required
- closed decisions are immutable
- closing memo failure does not change the outcome
- completed decision is stored in Team Agent history

---

# 13. M7 — Seeded Demonstration

## Objective

Make the deployed application immediately demonstrable.

## Seed scenario

Create a normal decision already in:

```text
DISCUSS
```

with:

- owner
- existing participant(s)
- initial submissions
- current positions
- backdated discussion
- facilitator state
- meaningful disagreement

## No demo mode

Do not introduce demo-specific runtime logic.

The demonstration is an ordinary persisted decision.

## Idempotency

Repeated:

```bash
npm run seed
```

must not create duplicate demo decisions.

## Acceptance criteria

A fresh deployment contains a usable seeded decision.

A new participant can enter through a participant link, receive the Current State Brief, and participate in the discussion.

---

# 14. M8 — Hardening, Evaluation, Documentation

## Objective

Bring the project to take-home quality without turning it into a production system.

## Domain tests

Cover:

- lifecycle invariants
- authorization
- immutable submissions
- position changes
- confidence handling
- close semantics
- projections

## Agent tests

Cover:

- authentication
- bootstrap
- submission
- Reveal
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
→ Team history
```

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

The security limitation must explicitly state:

> Participant links are bearer credentials. Anyone possessing a participant link can act as that participant. The links are intentionally lightweight and are not appropriate credentials for sensitive information. There is no account recovery mechanism.

---

# 15. Final Repository Structure

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

The exact organization may evolve if implementation demonstrates that another structure is materially better. Such changes must be reported and incorporated into a subsequent plan revision when they affect future work.

---

# 16. Definition of Done

## Product

- Decision can be framed/configured.
- Participants privately submit positions.
- Reveal occurs automatically or by owner declaration.
- Participants discuss asynchronously.
- Participants explicitly change positions.
- Facilitator surfaces assumptions, conflicts, and cruxes.
- Facilitator intervenes selectively and neutrally.
- Board reflects useful current state.
- Current State Brief orients participants.
- Owner declares final outcome.
- Closing memo synthesizes reasoning.
- Closed decision enters Team history.

## Architecture

- Decision Agent is authoritative.
- Team Agent stores history.
- SQLite is authoritative persistence.
- Agent realtime state remains small.
- Workflows perform durable AI processing.
- AI never blocks participant operations.
- AI output is validated.
- Stale AI results cannot overwrite newer state.

## Deployment

A developer can deploy with minimal Cloudflare dashboard interaction:

```bash
npm install
npm run setup
```

## Demo

A fresh deployment contains a seeded decision demonstrating the core product value.

## Engineering quality

- Core invariants are tested.
- Runtime-dependent behavior is tested in the appropriate runtime.
- Concurrency behavior is tested.
- AI failure is tested.
- Model evaluation is performed.
- README explains architecture and intentional limitations.

---

# 17. AI-Assisted Development Record

The requirements document and this implementation plan form the stable design context supplied to coding agents.

Each milestone should additionally receive a milestone-specific prompt.

The intended development record is:

```text
Requirements
    ↓
Implementation Plan Revision 1.0
    ↓
M0 Agent Prompt
    ↓
M0 Result / Findings
    ↓
M1 Agent Prompt
    ↓
M1 Result / Findings
    ↓
Implementation Plan Revision 1.1
    ↓
M2 Agent Prompt
    ↓
M2 Result / Findings
    ↓
Implementation Plan Revision 1.2
    ↓
M2 Agent Prompt updated for runtime testing
    ↓
M2 Result / Findings
    ↓
Implementation Plan Revision 1.3
    ↓
M2 Agent Prompt updated for client UI
    ↓
M3 Agent Prompt
    ↓
...
```

A plan revision is created whenever requirements or implementation strategy materially changes.

Minor implementation clarifications may increment the revision without changing the architecture.

The prompt history should preserve:

- requirements document
- applicable implementation-plan revision
- milestone prompt
- relevant prior milestone findings
- subsequent correction/instruction when required

The goal is to demonstrate deliberate AI-assisted engineering:

```text
Human establishes requirements
        ↓
Human establishes architecture
        ↓
AI implements bounded milestone
        ↓
AI reports evidence and discoveries
        ↓
Human evaluates implications
        ↓
Plan is revised when warranted
        ↓
Next AI agent receives authoritative context
```

The implementation agents are implementation partners, not autonomous architects.