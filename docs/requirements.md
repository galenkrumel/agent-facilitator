# Async Decision Facilitator — Requirements

## 1. Product Thesis

A small team makes an asynchronous decision. Everyone commits privately, then discusses openly. An AI facilitator helps the team surface conflicting assumptions without making the decision for them.

### Core Product Principle

**The facilitator facilitates disagreement; it does not make the decision, recommend an option, or generally coach participants.**

The product should feel like a lightweight decision process rather than an AI assistant that happens to be attached to a discussion.

---

# 2. Decision Lifecycle

A decision moves through four phases:

**Frame → Submit → Discuss → Close**

The transition from Submit to Discuss is called the **Reveal**. Reveal is an automatic/system transition, not a separate phase.

## Frame

The owner defines:

- Decision question
- Optional context
- 2–4 proposed options

The application automatically adds an **Other** option.

The owner is responsible for framing the question and options. The facilitator does not formulate options or recommend how the decision should be framed.

## Submit

Each invited participant privately submits:

- Initial position
- Confidence from 1–5
- Up to three reasons

Initial submissions are private until Reveal.

The facilitator is also blind to submissions during this phase.

There are **no submission deadlines**.

The Submit phase ends when either:

1. All invited participants have submitted, or
2. The owner explicitly declares submissions complete.

The owner may declare submissions complete even when one or more invited participants have not submitted. This is intentional: participation is voluntary and a non-participating person must not be able to hold up the decision.

A participant who has not submitted has no initial position or confidence to reveal. They may nevertheless participate in the subsequent Discuss phase.

Once Reveal occurs, initial submissions are immutable historical facts. No new initial submissions may be added.

## Reveal

At Reveal:

- All submitted initial positions, confidence levels, and reasons become visible to participants.
- The facilitator gains access to the initial submissions.
- The facilitator may identify meaningful initial disagreement or potential cruxes.

The facilitator must not manufacture an assessment or intervention simply because Reveal has occurred. If there is no meaningful insight to surface, no facilitator intervention is required.

## Discuss

Discuss is an open, shared chronological conversation.

There is:

- One discussion thread
- No nested replies
- No explicit `@mentions`
- Immutable messages
- No editing or deletion of messages

Participants can address one another naturally by name.

Corrections are made through follow-up messages.

The discussion has **no deadline**. It continues until the owner decides to close the decision.

### Changing Position

A participant may change their current position during discussion by explicitly stating that they are changing position and explaining their new position.

The facilitator must not infer a position change merely because a participant's reasoning evolves.

The participant's **current position** is what matters. The original submission becomes historical context rather than the authoritative current position.

If a participant explicitly changes position but does not provide a new confidence level, the facilitator asks them for their confidence, from 1–5, so the current decision state remains complete.

A participant may also explicitly update their confidence without changing their position.

Position-change history is not retained as a separate feature in the MVP.

## Close

The owner may close the decision at any time.

Before closing, the facilitator may warn the owner about:

- Unresolved cruxes
- Significant unresolved disagreement
- Other important issues that remain open

This warning is advisory and **cannot prevent closure**.

When closing, the owner explicitly declares/selects the final outcome.

The facilitator never chooses or infers the outcome.

Once closed:

- Discussion is frozen.
- No new messages may be posted.
- No positions may be changed.
- No facilitator interventions may occur.
- The decision becomes read-only.

The facilitator then produces the closing memo.

---

# 3. Participants and Identity

There are no user accounts.

A participant has:

- Display name
- Decision-specific secret participant token/link

The participant link:

- Is persistent for the duration of the decision
- Is not single-use
- Does not automatically expire
- Resolves to the same participant when reused from another device or from a previously shared link

The participant link is effectively a bearer credential.

This creates an intentional MVP security limitation:

> Anyone who possesses a participant's link can act as that participant.

This limitation must be clearly documented in the README. The system should not claim that these credentials are appropriate for highly sensitive information.

There is no account recovery.

Participants do not explicitly join a team. They enter a specific decision using their participant link.

## Owner Identity

The owner has a separate secret owner token/link scoped to the decision.

The owner can:

- Perform participant actions on their own behalf
- Declare submissions complete
- Close the decision

The owner cannot alter another participant's submitted position.

There is no email-based invitation or notification system. The owner shares participant links externally.

---

# 4. Team Model

A team is a container for decisions and accumulated team learning.

The team stores:

- Closed decision memos
- Significant assumptions that were challenged or refuted

The MVP does not require sophisticated team-history search, retrieval, or profile functionality.

Team membership is intentionally lightweight and does not require user accounts.

---

# 5. AI Facilitator

The facilitator is a visible participant in the chronological discussion.

It serves the collective decision process, not either side of a disagreement.

The facilitator:

- Observes the discussion continuously
- Intervenes selectively
- Remains neutral
- Does not recommend an option
- Does not express a preferred outcome
- Does not generally coach participants on how to reason

The facilitator's purpose is specifically to help the team surface **meaningful disagreement and the assumptions underneath it**.

## Facilitator Responsibilities

The facilitator has five core responsibilities:

1. Reveal analysis
2. Discussion interventions
3. Board maintenance
4. Current State Brief
5. Closing synthesis

### Reveal Analysis

After Reveal, the facilitator examines the initial submissions for meaningful disagreement, conflicting assumptions, and potential cruxes.

It should surface something only when there is a meaningful insight.

### Discussion Interventions

The facilitator may intervene when it identifies a meaningful, decision-relevant disagreement or crux.

It should **not** intervene merely to:

- Restate obvious information
- Ask generic coaching questions
- Improve someone's reasoning in the abstract
- Appear useful
- Manufacture a question where no meaningful issue exists

The absence of an intervention is a valid outcome.

The facilitator should not repeat the same intervention unless subsequent discussion materially changes the underlying issue.

### Assumptions

Assumptions may be:

- Explicitly stated by a participant
- Inferred from participant reasoning

An inferred assumption is a **hypothesis**, never an asserted fact.

When surfacing an inferred assumption, the facilitator phrases it as a question directed toward the participant who appears to hold it.

For example:

> "Are you assuming that demand will remain roughly flat?"

rather than:

> "You're assuming demand will remain flat."

Significant assumptions that are subsequently challenged or refuted may become part of team history.

### Conflicts

A conflict is an internal facilitator concept representing incompatible assumptions, claims, or positions.

Conflicts are not a separate participant-facing board category.

A conflict may result in:

- A crux
- A facilitator intervention
- Both
- Neither, if it is not sufficiently meaningful

### Cruxes

A **crux** is an unresolved question or fact that materially affects the decision or separates competing positions.

Cruxes are particularly important to the user-facing experience and should be visible on the board.

### Neutrality

The facilitator must remain neutral.

It can:

- Restate
- Organize
- Compare
- Identify contradictions
- Surface assumptions
- Identify cruxes
- Ask clarifying questions

It cannot:

- Recommend an option
- Choose an outcome
- Advocate for a position
- Substitute its own analysis for the team's discussion

---

# 6. Decision Board

The facilitator maintains an internal working model containing:

- Positions
- Assumptions
- Cruxes
- Conflicts
- Action items

The participant-facing board is a curated representation of that understanding and exposes only:

- **Current Positions**
- **Cruxes**
- **Action Items**

Assumptions and conflicts do not need to appear as separate board categories.

The distinction is intentional:

> The facilitator maintains more information internally than it exposes directly to participants.

The board is not a raw extraction of the conversation.

Participants cannot directly edit board items in the MVP.

Evidence/provenance inspection — such as clicking a board item to see the source messages supporting it — is **not part of the MVP**.

---

# 7. Current State Brief

The Current State Brief is a core product feature.

It provides orientation when a participant enters an existing decision.

### First Visit

A participant entering a decision receives a concise, neutral summary of the current state, potentially including:

- Current positions
- Meaningful disagreements
- Open cruxes
- Important challenges to assumptions
- Questions requiring a response
- Relevant action items

### Returning Visit

A returning participant receives a personalized brief describing what has changed since their **last visit/opening of the decision**, rather than simply since the last message.

The brief may include:

- Changes in current positions
- New or resolved cruxes
- Challenges to assumptions
- Important discussion developments
- Questions requiring their response

The brief should be neutral and useful for quickly re-entering the conversation.

A participant's viewing history is therefore sufficient to establish the "since your last visit" boundary; a sophisticated activity/notification system is not required.

---

# 8. Closing Memo

When the owner closes the decision and declares the outcome, the facilitator produces a closing memo containing:

### Decision

The outcome explicitly declared by the owner.

### Reasoning

A grounded synthesis of the reasoning expressed during the discussion.

The facilitator should not introduce new facts, analysis, or recommendations.

### Refuted Assumptions

Important assumptions that were challenged or refuted during the discussion.

These become part of the team's institutional learning.

### Unresolved Issues

Important cruxes or disagreements that remained unresolved when the owner closed the decision.

### Dissent

Meaningful disagreement that remained at closure.

### Action Items

Commitments identified during the discussion.

The closing memo is stored in team history.

Team history also retains significant assumptions that were challenged or refuted, but the MVP does not require sophisticated historical browsing or search.

---

# 9. Authorization

| Capability | Participant | Owner | Facilitator |
|---|---:|---:|---:|
| View authorized decision | ✓ | ✓ | — |
| Submit own initial position | ✓ | ✓ | — |
| Post discussion messages | ✓ | ✓ | ✓ |
| Change own current position | ✓ | ✓ | — |
| Update own confidence | ✓ | ✓ | — |
| Declare submissions complete | — | ✓ | — |
| Modify another participant's position | — | — | — |
| Directly edit board | — | — | — |
| Close decision | — | ✓ | — |
| Recommend outcome | — | — | — |
| Declare outcome | — | ✓ | — |
| Maintain facilitator-derived state | — | — | ✓ |
| Generate closing memo | — | — | ✓ |

The facilitator cannot alter the owner's declared outcome.

---

# 10. Architecture Requirements

The implementation should use the following Cloudflare architecture:

### Agents

Use the Agents SDK with:

- A **Team Agent**
- A **Decision Agent**

Each agent is implemented as a Durable Object with built-in SQLite storage.

### Team Agent

Stores:

- Team identity
- Closed decision memos
- Significant historical assumptions

### Decision Agent

Stores:

- Decision state
- Participants
- Initial submissions
- Current positions
- Discussion messages
- Facilitator state
- Board state
- Relevant participant visit state

The Decision Agent provides live updates to connected browsers.

### Workflow

A Workflow coordinates decision lifecycle processing and durable AI work across execution boundaries.

Because the process has no deadlines, the Workflow is not responsible for advancing phases based on timers.

### Model

Use Workers AI with **Llama 3.3**, subject to the model evaluation described below.

If Llama 3.3 does not meet the requirements, another model may be selected before proceeding with the full implementation.

### Frontend

Use the Agents starter's frontend/hosting approach.

The specific implementation details of state synchronization, Workflow coordination, and Agent APIs are implementation concerns rather than product requirements.

---

# 11. Non-Functional Requirements

The system should:

- Preserve decision state across browser refreshes.
- Preserve state when participants leave and return.
- Preserve state across Workflow execution boundaries and sleeps/wakeups.
- Support multiple participants viewing and interacting with a decision concurrently.
- Prevent concurrent activity from corrupting decision state.
- Deliver discussion and state changes to connected browsers without requiring manual refresh.

AI is inherently non-deterministic and fallible.

The system must tolerate cases where:

- The model identifies no meaningful insight.
- An inferred assumption is rejected.
- No board update is warranted.
- The model fails.
- The model returns malformed structured output.

The MVP does not require production-grade reliability infrastructure, sophisticated observability, or comprehensive failure recovery beyond what is necessary to keep the demonstration usable.

---

# 12. Model Evaluation

Before building the full facilitator experience, evaluate the selected model against a representative discussion transcript.

The evaluation should take approximately the first hour of implementation.

### Test Transcript

Use a scripted transcript of approximately 40 messages containing:

- Known explicit assumptions
- Known conflicts
- At least two implicit conflicts
- Multiple participants
- Realistic, somewhat messy discussion

### Success Criteria

The model should:

- Identify at least **80% of the known assumptions**
- Correctly attribute identified assumptions to the appropriate participant
- Produce valid structured output reliably, without requiring repeated retries in most runs
- Identify at least one of the two implicit conflicts
- Avoid inventing conflicts that are not present

If Llama 3.3 fails these requirements, switch models before investing in the full implementation.

---

# 13. Seeded Scenario / Demonstration

The deployed application should include a pre-seeded decision that is already partway through the Discuss phase.

The seeded decision contains:

- Two existing participants
- Backdated discussion messages
- A meaningful disagreement
- Facilitator state reflecting the existing discussion

A new participant can enter the decision and receive a Current State Brief before joining the discussion.

The application itself should not treat this as a special "demo mode." It should simply be a valid pre-existing decision state.

The facilitator must operate against the actual discussion rather than special-cased scripted behavior.

The application should support multiple participants interacting concurrently.

The README should explain:

- How to run the application locally
- How to deploy it
- How to access the seeded scenario
- The intentional bearer-token security limitation

---

# 14. Out of Scope

The MVP does **not** include:

- User accounts
- Account recovery
- Email
- Notifications
- Invitation-management infrastructure
- Presence indicators
- Nested/threaded discussion
- Message editing
- Message deletion
- Explicit `@mentions`
- Participant position-change history
- Evidence/provenance UI
- General-purpose AI assistance
- General reasoning coaching
- AI recommendations
- AI-selected outcomes
- Sophisticated team-history search or retrieval
- Post-close action-item tracking
- Voice
- Mobile-specific design
- File uploads
- External integrations
- Participant editing or dismissing AI-generated board items
- An `@facilitator` command
- Deadline-based phase transitions
- Submission deadlines
- Deadline extensions

---

# 15. Product Principles

The following principles should guide implementation decisions when requirements are ambiguous.

### Humans define and decide.

The owner frames the decision and declares the outcome.

### AI facilitates disagreement.

The facilitator's job is to help participants see where their assumptions or conclusions diverge.

### Do not manufacture insights.

If there is nothing meaningful to surface, the facilitator should remain quiet.

### Observe continuously; intervene selectively.

The facilitator should understand the evolving discussion without feeling compelled to comment on every development.

### Current state matters most.

A participant's current position is more important than their original position as the discussion evolves.

### The facilitator is neutral.

It serves the decision process, not a particular participant or outcome.

### The facilitator maintains more than it exposes.

The internal model can contain assumptions and conflicts that do not need to appear directly on the participant-facing board.

### Participation is voluntary.

An invited participant who does not submit must not be able to hold up the decision. The owner decides when the team has had enough opportunity to provide initial positions.

### Identity is intentionally lightweight.

Decision-specific bearer links are sufficient for the MVP, with their limitations explicitly acknowledged.

### The product should remain lightweight.

This is an optional engineering project, not a production-grade collaboration platform. Prefer the smallest implementation that demonstrates the core thesis convincingly.