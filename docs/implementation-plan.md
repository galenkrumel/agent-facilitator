# Async Decision Facilitator
## Repo-Level Implementation Plan — Revision 1.5

## Revision History

| Revision | Change |
|---|---|
| **1.0** | Initial repo-level implementation plan |
| **1.1** | Incorporated M1 findings; clarified decision creation, persisted lifecycle states, owner credential model, session persistence, and explicitly rejected a public `/d/new` product endpoint |
| **1.2** | Added minimum Workers-runtime integration testing to M2 so transactionality, Durable Object serialization, race determinism, and post-commit Workflow scheduling can be directly proven |
| **1.3** | Explicitly assigned the minimum submission/owner UI to M2. M2 now delivers the Submit → Reveal experience end-to-end in the browser; M3 owns the discussion UI and realtime discussion experience |
| **1.4** | Incorporated M2 implementation findings: `/d/new` is development-only and eliminated from production bundles; absence of a `current_positions` row represents no current position; revealed initial submissions are exposed through bootstrap after Reveal; Workers-runtime and transport-level verification are complete; M3 owns realtime and M8 owns visual/E2E verification |
| **1.5** | Incorporated M3 implementation findings: realtime state remains a non-authoritative projection; client-originated Agent state must be validated and cannot override SQLite; projection updates are followed by authoritative reads; M3 discussion/realtime implementation is complete |

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

## 2.6 Realtime state is never authoritative

Agents SDK realtime state is a projection of authoritative SQLite state.

Client-originated state updates are untrusted input.

Any client-originated state change must be validated against authoritative state before acceptance.

Clients must never be able to establish or overwrite authoritative decision state by pushing arbitrary realtime state.

When correctness matters, the application may re-read authoritative state from SQLite after a realtime update rather than attempting to reconstruct correctness from client-visible state.

## 2.7 Milestones should produce vertical slices

When a milestone introduces user-visible behavior, it should include the minimum client UI required to exercise that behavior end-to-end.

Later milestones own their own richer UX.

The goal is not to build the entire UI early; it is to avoid creating server functionality that cannot be exercised through the actual application.

## 2.8 No silent scope expansion

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

# 4. Settled Decisions from M1–M3

## 4.1 Decision creation is not currently a public product capability

M1 introduced:

```text
POST /d/new
```

to satisfy the practical need to create a decision.

This was rejected as a product capability.

The M2 implementation retains the route only as a development-only fixture guarded by a build-time development constant. Its handler is eliminated from the production bundle.

A deployed instance therefore does not expose `/d/new` as a decision-creation endpoint.

For development and demonstration purposes, decisions may be created through seed/development tooling.

M7 must replace the development creation path with the normal seeded demonstration scenario.

If a user-facing decision-creation experience is later desired, it must be explicitly added to the requirements and implementation plan.

### Rejected decision

Do not preserve `/d/new` as a deployed product API.

Do not build additional functionality around it.

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

## 4.5 No current position is represented by absence of a row

A participant who has not submitted an initial position has no `current_positions` row.

This represents:

```text
no row
    →
no current position
```

The nullable columns remain available for future explicit withdrawal semantics in M5, but M2 does not implement withdrawal.

---

## 4.6 Initial submissions become visible after Reveal

`DecisionBootstrap` includes initial submissions.

Before Reveal:

```text
initialSubmissions = []
```

Participants can see that submissions exist but cannot see another participant's:

- selected option
- confidence
- reasons

After Reveal:

```text
initialSubmissions = all submitted initial submissions
```

Initial submissions remain historical context after Reveal.

---

## 4.7 Realtime state is a projection

The Agents SDK realtime state contains a small projection:

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

The projection is derived from authoritative SQLite state.

Version/counter fields are not independently authoritative state.

Client-originated state updates must be validated and cannot be allowed to create state that SQLite does not support.

The application may re-read authoritative state after a realtime change. This keeps the live path and refresh path based on the same source of truth.

---

# 5. Milestone Overview

| Milestone | Objective | Exit condition |
|---|---|---|
| **M0** | Cloudflare-as-code setup | One-command deployment works |
| **M1** | Application spine | Real Decision Agent can bootstrap a decision |
| **M2** | Decision lifecycle | Submit → Reveal works correctly, is directly runtime-tested, and can be exercised end-to-end through the browser transport path |
| **M3** | Discussion | Realtime chronological discussion works |
| **M4** | Facilitator foundation | AI can analyze Reveal/discussion safely |
| **M5** | Decision intelligence | Board, cruxes, position changes, brief work |
| **M6** | Closing + history | Owner closes and Team Agent stores result |
| **M7** | Seeded demo | Fresh deployment is immediately demonstrable |
| **M8** | Hardening | Comprehensive tests, visual/E2E verification, evaluation, failure handling, README complete |

---

# 6. M0 — Cloudflare-as-Code Setup

M0 is complete.

---

# 7. M1 — Application Spine

M1 is complete.

---

# 8. M2 — Decision Lifecycle

M2 is complete.

It established:

- initial submissions
- automatic Reveal
- owner-forced Reveal
- transactional lifecycle
- current-position initialization
- submission privacy
- post-Reveal submission visibility
- post-Reveal Workflow scheduling boundary
- minimum submission/owner UI
- Workers-runtime test infrastructure
- runtime transaction/race verification

---

# 9. M3 — Discussion + Realtime

M3 is complete.

## Objective

Implement the live asynchronous discussion experience.

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

## Realtime

Use Agents SDK realtime state synchronization.

Maintain only small projection state.

Historical messages remain in SQLite.

A realtime state update is never treated as authoritative merely because it arrived through the Agent connection.

## Client UI

Implement:

- discussion display
- message composer
- connection status

The discussion UI is responsible for rendering current state but does not become a second persistence mechanism.

## Concurrency

Decision Agent is the serialization boundary.

M3 verifies:

- multiple participant sessions
- simultaneous discussion activity
- discussion vs. Reveal
- refresh/reconstruction from SQLite
- realtime delivery without manual refresh
- client-originated projection tampering is rejected

The message-vs-close race is deferred to M6 because close does not exist yet.

## Acceptance criteria

Two browser sessions can participate simultaneously.

A committed message becomes visible to another connected participant without manual refresh.

A refresh reconstructs discussion from authoritative SQLite state.

Client-originated realtime state cannot override authoritative state.

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

Verify actual Workers AI inference and resolve the remaining model-binding/permission question.

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

## State authority

AI output is also untrusted input.

AI-generated state must pass the same validation discipline as any other non-authoritative input before it changes SQLite state.

The facilitator must never be allowed to bypass Decision Agent domain invariants.

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

Make the deployed application immediately demonstrable without relying on the development-only decision creation fixture.

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

## Seed mechanism

Provide an idempotent seed mechanism that can create the demonstration decision without exposing `/d/new` as a production API.

The seed mechanism should produce the participant links required for demonstration.

The existing M1/M2 `frameDecision()` capability may be used internally by setup/seed tooling.

It is not a user-facing product API.

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
- rejection of invalid client-originated state

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

## E2E and visual verification

Exercise the actual browser UI across the complete lifecycle.

Verify:

- React rendering
- submission form
- owner controls
- Reveal
- discussion
- realtime updates
- facilitator messages
- board
- Current State Brief
- position changes
- closing
- closing memo
- Team history

## M2/M3 visual gap

M2 and M3 server/runtime and transport behavior are verified.

M8 is responsible for the remaining visual/UI verification that could not be performed through automated browser interaction during those milestones.

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
- development-only `/d/new` behavior and its non-contractual status
- Workers/Vitest runtime test setup and dependency requirements
- realtime state authority and client-state validation

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
│   │   ├── components/
│   │   ├── hooks/
│   │   └── main.tsx
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
│   │   ├── facilitator/
│   │   └── workflows/
│   └── shared/
│
├── seed/
├── scripts/
├── evals/
├── test/
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
- Agent realtime state remains a small projection.
- Client-originated realtime state cannot override authoritative state.
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

The deployed application does not expose `/d/new` as a product decision-creation endpoint.

## Demo

A fresh deployment contains a seeded decision demonstrating the core product value.

## Engineering quality

- Core invariants are tested.
- Runtime-dependent behavior is tested in the appropriate runtime.
- Concurrency behavior is tested.
- AI failure is tested.
- Model evaluation is performed.
- Browser/UI behavior is E2E verified.
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
M2 runtime-testing clarification
    ↓
M2 Result / Findings
    ↓
Implementation Plan Revision 1.3
    ↓
M2 UI clarification
    ↓
M2 Result / Findings
    ↓
Implementation Plan Revision 1.4
    ↓
M3 Agent Prompt
    ↓
M3 Result / Findings
    ↓
Implementation Plan Revision 1.5
    ↓
M4 Agent Prompt
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