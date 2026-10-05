# Async Decision Facilitator
## Repo-Level Implementation Plan — Revision 1.8

## Revision History

| Revision | Change |
|---|---|
| **1.0** | Initial repo-level implementation plan |
| **1.1** | Incorporated M1 findings; clarified decision creation, persisted lifecycle states, owner credential model, session persistence, and explicitly rejected a public `/d/new` product endpoint |
| **1.2** | Added minimum Workers-runtime integration testing to M2 so transactionality, Durable Object serialization, race determinism, and post-commit Workflow scheduling can be directly proven |
| **1.3** | Explicitly assigned the minimum submission/owner UI to M2. M2 now delivers the Submit → Reveal experience end-to-end in the browser; M3 owns the discussion UI and realtime discussion experience |
| **1.4** | Incorporated M2 implementation findings: `/d/new` is development-only and eliminated from production bundles; absence of a `current_positions` row represents no current position; revealed initial submissions are exposed through bootstrap after Reveal; Workers-runtime and transport-level verification are complete; M3 owns realtime and M8 owns visual/E2E verification |
| **1.5** | Incorporated M3 implementation findings: realtime state remains a non-authoritative projection; client-originated Agent state must be validated and cannot override SQLite; projection updates are followed by authoritative reads; M3 discussion/realtime implementation is complete |
| **1.6** | Incorporated M4 model evaluation and facilitator findings: Llama 3.3 failed the required evaluation and was replaced by `gpt-oss-120b`; the facilitator now persistently applies validated AI state; M5 explicitly owns meaningful intervention selectivity; evaluation rubric revisions must remain part of the development record |
| **1.7** | Accepted M5 and defined M6 in detail. This revision was kept outside the repository; M6 was built against it, and 1.8 records what that produced |
| **1.8** | Incorporated M5 and M6 implementation findings: the intervention gate compares an issue key and a material state digest; unchanged facilitator state keeps its timestamp; reading the Current State Brief is the visit; the closing memo's outcome is copied, never model-supplied; memo list fields are selections grounded in facilitator state; dissent is grounded against final positions; closing synthesis does not share the analysis slot; team history is written only from a completed memo. M5 and M6 are complete; M7 is next |

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
- Workers AI is the model runtime.
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

## 2.7 AI-derived state is never authoritative by default

AI output is an observation or proposed state change.

It must be validated before being applied to authoritative state.

The Decision Agent remains the sole authority for:

- whether a proposed facilitator state change is valid
- whether it is consistent with current state
- whether it can be persisted
- whether it can affect participant-visible state

The facilitator cannot bypass domain invariants.

## 2.8 Milestones should produce vertical slices

When a milestone introduces user-visible behavior, it should include the minimum client UI required to exercise that behavior end-to-end.

Later milestones own their own richer UX.

The goal is not to build the entire UI early; it is to avoid creating server functionality that cannot be exercised through the actual application.

## 2.9 No silent scope expansion

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

# 4. Settled Decisions from M1–M6

## 4.1 Decision creation is not currently a public product capability

M1 introduced `/d/new` to satisfy the practical need to create a decision.

This was rejected as a product capability.

The M2 implementation retains the route only as a development-only fixture guarded by a build-time development constant. Its handler is eliminated from the production bundle.

A deployed instance does not expose `/d/new` as a decision-creation endpoint.

M7 must replace the development creation path with the normal seeded demonstration scenario.

### Rejected decision

Do not preserve `/d/new` as a deployed product API.

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

The persistent link:

- does not expire automatically
- can be reused
- can establish sessions in different browsers/devices

The session:

- is browser-local
- may expire
- does not replace the persistent link

Losing the persistent link means there is no account-recovery mechanism.

---

## 4.4 Frame is conceptual, not persisted

The product lifecycle is:

```text
Frame → Submit → Discuss → Close
```

The persisted state is:

```text
SUBMIT → DISCUSS → CLOSED
```

There is no persisted `FRAME` status.

---

## 4.5 No current position is represented by absence of a row

A participant who has not submitted an initial position has no `current_positions` row.

This represents:

```text
no row
    →
no current position
```

Nullable columns remain available for future explicit withdrawal semantics.

---

## 4.6 Initial submissions become visible after Reveal

Before Reveal:

```text
initialSubmissions = []
```

After Reveal:

```text
initialSubmissions = all submitted initial submissions
```

Initial submissions remain historical context after Reveal.

---

## 4.7 Realtime state is a projection

Agents SDK realtime state is a small projection derived from authoritative SQLite state.

Client-originated realtime state cannot override SQLite.

When correctness matters, authoritative state is re-read rather than inferred from client state.

---

## 4.8 Selected AI model

The initial candidate model, Llama 3.3, was evaluated against the required facilitator transcript.

Results:

```text
Llama 3.3
Assumption recall: 57%
Required: ≥80%
Result: FAIL
```

A larger token budget and sharper prompt did not materially improve the result.

The model was therefore rejected for the facilitator.

The selected model is:

```text
@cf/openai/gpt-oss-120b
```

Evaluation results:

```text
Assumption recall: 97%
Attribution: 93%
Implicit conflict detection: 3/3 runs
Invented conflicts: 0
Structured output: valid across evaluated runs
```

The selected model should remain the default unless later implementation evidence demonstrates a material problem.

The facilitator's `max_tokens` is 8192. M5's wider response was truncated mid-array at 4096, and a truncated response is invalid JSON rather than a short answer. If the response schema grows again, re-run the evaluation and check structured-output validity first.

Do not repeatedly re-run expensive model selection exercises without new evidence.

---

## 4.9 Facilitator state is persistently applied in M4

M4 implements the complete validated state pipeline:

```text
LLM
 ↓
parse
 ↓
schema validation
 ↓
semantic validation
 ↓
transactional application
 ↓
Decision Agent SQLite
```

M4 persists:

- assumptions
- cruxes
- conflicts
- action items
- facilitator status
- interventions

M5 owns the participant-facing board projection, Current State Brief, position changes, and intervention selectivity.

---

## 4.10 Evaluation methodology is part of the development record

The facilitator evaluation uses the product's actual prompt and validator rather than independent evaluation logic.

If evaluation reveals that a rubric is overly lexical and fails to recognize semantically valid model behavior, the rubric may be revised.

Such revisions must be disclosed in the milestone report and preserved in the development record.

The goal is to measure substantive facilitator behavior rather than keyword overlap.

---

## 4.11 The intervention gate compares material state, not wording

An intervention is identified by an issue key plus a digest of the decision's material facilitator state:

- cruxes
- conflicts
- current positions
- assumptions whose status is not `OPEN`

An issue already raised may be raised again only when that digest has changed.

Open assumptions are excluded on purpose. The facilitator adds one on almost every message, so including them moved the digest on every analysis and the gate never closed.

The digest is decision-wide, not per-issue. A material change anywhere can reopen any issue. This ceiling is accepted for the MVP and documented in the README.

---

## 4.12 Unchanged facilitator state keeps its timestamp

Every analysis rewrites the whole facilitator model.

A row that survives an analysis unchanged keeps its previous timestamp. Stamping every row with the current time would make everything look freshly changed: the Current State Brief would report phantom changes and the intervention gate would reopen.

---

## 4.13 Position changes stated in a participant's own words count

Only explicit position changes are applied (M5).

"Explicit" means the participant states the change, in whatever words they use. It does not require a particular phrasing or UI action. End-to-end verification found that changes stated in a participant's own words were being ignored; they are now applied.

Inferred changes, and changes in reasoning alone, are never applied.

---

## 4.14 Reading the Current State Brief is the visit

`getCurrentStateBrief()` records `last_visited_at` when it is read.

The client reads it once per opening and never on a realtime update. Re-reading it on every projection change would reset the participant's own "since your last visit" boundary to seconds ago.

The boundary is strict: only items created after the last visit count as new.

---

## 4.15 The owner closes with an option; the facilitator cannot change it

`closeDecision(outcomeOptionId)` takes one of the decision's options. The close transaction verifies owner, `DISCUSS`, and a valid option.

Before closing, the owner can read a closing advisory (unresolved cruxes and similar). It is a separate read with no path into the close transaction, so it can warn but never delay or refuse a close.

The closing memo's outcome is copied from the closed decision. The closing JSON schema has no outcome field, so the model cannot supply one.

### Rejected decision

Do not add a model-supplied outcome field "for validation." A field that does not exist is a stronger guarantee than a field that is checked.

---

## 4.16 Closing memo grounding

- **List fields are selections, not compositions.** The prompt gives the model the exact statements in facilitator state, and the validator drops anything that is not one of them. One function, `closingKnownState()`, builds that set for both the prompt and the validator.
- **Dissent is grounded per line against final positions.** A line that names nobody holding a position, or that puts a participant on an option they did not end on, is dropped.
- **Free-form prose is grounded by the prompt only.** The memo's reasoning and the facilitator's intervention text cannot be checked deterministically. This is an accepted MVP limitation, documented in the README.

### Rejected decision

Do not validate prose with a second model call. A second model judging the first is another untrusted output in the same position, not validation.

---

## 4.17 Closing is independent of discussion analysis

A discussion analysis can still be running when the owner closes.

- Closing synthesis does not claim the analysis slot. The memo row's own status is what makes it run once.
- Once the decision is not `DISCUSS`, `applyAnalysis()` refuses everything. A closed decision is frozen, and the memo is written from what was committed before the close.
- `failAnalysis()` schedules no follow-up after close.

---

## 4.18 Team history is written from a completed memo

The closing Workflow files the decision with the Team Agent only after the memo is applied. A record is not produced while the memo is pending or failed.

Significant learnings are derived from authoritative facilitator state (assumptions with status `CHALLENGED` or `REFUTED`), not taken from the memo. The memo's refuted-assumption list is the model's selection from the same set; the two may legitimately differ.

The `/team/history/:id` route is development-only verification infrastructure, guarded the same way as `/d/new`.

---

# 5. Milestone Overview

| Milestone | Objective | Status |
|---|---|---|
| **M0** | Cloudflare-as-code setup | **Complete** |
| **M1** | Application spine | **Complete** |
| **M2** | Decision lifecycle | **Complete** |
| **M3** | Discussion + realtime | **Complete** |
| **M4** | Facilitator foundation | **Complete** |
| **M5** | Decision intelligence | **Complete** |
| **M6** | Closing + history | **Complete** |
| **M7** | Seeded demo | Next |
| **M8** | Hardening | Pending |

---

# 6. M0 — Cloudflare-as-Code Setup

Complete.

---

# 7. M1 — Application Spine

Complete.

---

# 8. M2 — Decision Lifecycle

Complete.

---

# 9. M3 — Discussion + Realtime

Complete.

M3 established:

- chronological discussion
- immutable messages
- canonical sequence numbers
- realtime projection
- live multi-session updates
- authoritative SQLite reads
- client-state validation
- post-commit facilitator scheduling

---

# 10. M4 — Facilitator Foundation

Complete.

## Objective

Introduce AI safely and establish the facilitator execution pipeline.

## Model evaluation

M4 evaluated the initial Workers AI model against the scripted approximately 40-message transcript.

Llama 3.3 failed the required ≥80% assumption-recall threshold.

`@cf/openai/gpt-oss-120b` passed with:

- 97% assumption recall
- 93% attribution
- implicit conflict detected in 3/3 runs
- no invented conflicts
- valid structured output

`gpt-oss-120b` is now the selected facilitator model.

## Facilitator pipeline

The pipeline is:

```text
FacilitatorContext
    ↓
prompt
    ↓
Workers AI
    ↓
JSON extraction/parsing
    ↓
schema validation
    ↓
semantic validation
    ↓
transactional Decision Agent application
```

## Workflow

M4 implements the durable facilitator Workflow path for:

```text
REVEAL
DISCUSSION
```

The CLOSING route may exist structurally, but closing behavior remains M6.

The Workflow:

1. reads state from Decision Agent
2. invokes the model
3. parses output
4. validates output
5. applies validated result

The Workflow does not own decision state.

## Discussion coalescing

Only one discussion analysis runs at a time.

Messages arriving while analysis is running set pending work.

Subsequent analysis processes the newly available message range.

## Stale results

AI results include the sequence range analyzed.

Decision Agent rejects or ignores stale/duplicate results.

## Facilitator state

M4 persistently applies validated:

- assumptions
- cruxes
- conflicts
- action items
- interventions

The Decision Agent remains authoritative over these state changes.

## Position changes

M4 validates position-change observations but does not apply them.

M5 owns position-change behavior and confidence follow-up.

## Intervention repetition

M4 has a basic repetition guard.

It is not sufficient to establish the product requirement of meaningful selectivity.

M5 must implement and test a stronger intervention gate based on whether the underlying issue has materially changed.

## Acceptance criteria

M4 is complete when:

- the model passes the required evaluation
- model output is parsed and validated
- malformed output cannot corrupt state
- valid facilitator state is persisted
- Reveal analysis executes
- discussion analysis executes
- facilitator interventions appear in the discussion
- facilitator messages do not recursively trigger facilitator analysis
- AI failure does not block participant operations
- stale AI results cannot overwrite newer state
- model choice is documented

---

# 11. M5 — Decision Intelligence

Complete. Implementation findings are recorded in §4.11–4.14.

## Objective

Complete the facilitator's participant-facing intelligence while preserving neutrality and selectivity.

## Facilitator state

Use the state established in M4:

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

## Intervention selectivity

The facilitator must:

- observe continuously
- intervene selectively
- remain neutral
- serve the collective decision
- avoid generic coaching
- avoid recommending options
- legitimately remain silent

A verbatim-repeat check is insufficient.

The intervention gate must consider whether the underlying issue has materially changed since the last intervention.

At minimum, test:

```text
Message A
    ↓
Facilitator identifies issue
    ↓
Facilitator intervenes

Message B
    ↓
Same issue, no material new information
    ↓
Facilitator remains silent

Message C
    ↓
Materially changed issue/new evidence
    ↓
Facilitator may intervene again
```

The exact implementation may use structured facilitator state, sequence ranges, issue identifiers, or another mechanism, but it must demonstrate semantic selectivity rather than string deduplication.

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

```text
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

## Acceptance criteria

M5 is complete when:

- board accurately reflects authoritative state
- cruxes are visible
- action items are visible
- assumptions are appropriately represented
- explicit position changes work
- confidence follow-up works
- inferred position changes do not occur
- facilitator demonstrates meaningful intervention selectivity
- repeated unchanged issues do not produce repeated interventions
- materially changed issues can produce renewed intervention
- Current State Brief works on first visit
- Current State Brief summarizes meaningful changes on subsequent visits
- no facilitator behavior recommends an option

---

# 12. M6 — Close + Team History

Complete. Implementation findings are recorded in §4.15–4.18.

## Objective

Complete the decision lifecycle and persist institutional history.

## Close

Implement:

```text
closeDecision(outcomeOptionId)
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

Store:

```text
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

## Open item carried forward

When closing synthesis fails after its retries, the decision stays closed with its outcome intact, but it never reaches Team Agent history, because a record is only produced from a completed memo (§4.18). The requirements do not say what history should hold in that case. M8 should decide whether to file the decision without a memo, offer a retry, or document the gap as a known limitation.

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

**Decide before implementing:** how seed tooling running on a developer's machine reaches the deployed Decision Agent without a public decision-creation endpoint. That choice affects the security model and must be settled in a plan revision first (§3).

Provide an idempotent seed mechanism that can create the demonstration decision without exposing `/d/new` as a production API.

The seed mechanism should produce the participant links required for demonstration.

The existing `frameDecision()` capability may be used internally by setup/seed tooling.

It is not a user-facing product API.

## No demo mode

Do not introduce demo-specific runtime logic.

The demonstration is an ordinary persisted decision.

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
- facilitator state application

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

## Facilitator evaluation

Preserve the model evaluation and methodology from M4.

The evaluation should include:

- assumption recall
- attribution
- implicit conflict detection
- false-positive/invented-conflict rate
- structured-output validity

Evaluation rubrics should favor semantic correctness over literal keyword matching.

Any rubric changes must be disclosed in the development record.

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
- selected model and evaluation
- seeded scenario
- local development
- known limitations
- AI-assisted development process
- development-only `/d/new` behavior
- Workers/Vitest runtime test setup and dependency requirements
- realtime state authority
- client-state validation
- facilitator validation pipeline
- intervention selectivity approach

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
- Workflow performs durable AI processing.
- AI never blocks participant operations.
- AI output is validated.
- AI-derived state changes pass through Decision Agent validation.
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
M4 Result / Findings
    ↓
Implementation Plan Revision 1.6
    ↓
M5 Agent Prompt
    ↓
M5 Result / Findings
    ↓
Implementation Plan Revision 1.7
    ↓
M6 Agent Prompt
    ↓
M6 Result / Findings
    ↓
Implementation Plan Revision 1.8
    ↓
M7 Agent Prompt
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