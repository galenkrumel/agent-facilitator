/**
 * What the facilitator asks the model, and how it asks for it.
 *
 * Pure and free of Cloudflare imports on purpose: the Workflow runs this
 * against the `AI` binding and `npm run eval` runs the identical prompt and
 * decoding parameters against the REST endpoint from Node. If the two could
 * drift, the evaluation would be measuring something the product does not do.
 */
import type { FacilitatorContext, Participant } from "../../shared/types.ts";
import type { FacilitatorWorkflowParams } from "../workflows/facilitator.ts";

/**
 * The model the facilitator runs on.
 *
 * The requirements name Llama 3.3 "subject to the model evaluation", and it
 * did not survive it: `npm run eval` scores it at 57% assumption recall
 * against a bar of 80%, stable across runs and unchanged by a larger token
 * budget or a more explicit prompt. It reliably finds five or six of the ten
 * known assumptions and stops. Everything else about it is fine — perfect
 * attribution, valid structured output, no invented conflicts — but a
 * facilitator that misses half of what a team is assuming is not doing the job
 * the product exists to do.
 *
 * gpt-oss-120b scores 100% recall, 97% attribution, finds both implicit
 * conflicts in two runs of three, and invents nothing. It is two to three
 * times slower, which costs nothing here: analysis is asynchronous and never
 * on a participant's path. `npm run eval -- --model=…` re-runs the comparison.
 */
export const FACILITATOR_MODEL = "@cf/openai/gpt-oss-120b";

/**
 * Decoding parameters. Low temperature because this is an extraction task with
 * a right answer, not a writing task: the facilitator should read the same
 * discussion the same way twice.
 *
 * 4096 tokens because a thorough analysis of a long discussion runs past 2048,
 * and a truncated one is not a shorter analysis — it is invalid JSON.
 */
export const INFERENCE = { temperature: 0.2, max_tokens: 4096 } as const;

/**
 * The shape the model is constrained to emit, for Workers AI structured
 * output. It is deliberately *not* `FacilitatorAnalysisResult`:
 *
 * - participants are named, not identified by UUID. A model that has to copy
 *   a UUID out of a prompt will eventually get one wrong, and a misattributed
 *   assumption is worse than a missing one. `parseAnalysis` resolves names.
 * - sequence numbers are not asked for. The Decision Agent knows which range
 *   was analyzed; the model does not need to be trusted with it.
 *
 * Constrained decoding is the first line of defence, not the only one — the
 * output is still parsed and validated as untrusted input.
 */
const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["assumptions", "cruxes", "conflicts", "actionItems", "positionChanges", "intervention"],
  properties: {
    assumptions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["participant", "statement", "source", "status"],
        properties: {
          participant: {
            type: ["string", "null"],
            description: "Display name of the participant who appears to hold it, or null."
          },
          statement: { type: "string" },
          source: { type: "string", enum: ["EXPLICIT", "INFERRED"] },
          status: { type: "string", enum: ["OPEN", "CONFIRMED", "CHALLENGED", "REFUTED"] }
        }
      }
    },
    cruxes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "status"],
        properties: {
          question: { type: "string" },
          status: { type: "string", enum: ["OPEN", "RESOLVED"] }
        }
      }
    },
    conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "participants", "status"],
        properties: {
          description: { type: "string" },
          participants: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["OPEN", "RESOLVED"] }
        }
      }
    },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "owner"],
        properties: {
          description: { type: "string" },
          owner: { type: ["string", "null"] }
        }
      }
    },
    positionChanges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["participant", "option", "confidence", "explicit"],
        properties: {
          participant: { type: "string", description: "Exact display name." },
          option: {
            type: ["string", "null"],
            description: "The option label they now hold, or null if only their confidence changed."
          },
          confidence: {
            type: ["integer", "null"],
            description: "Their new confidence 1–5, or null if they did not give one."
          },
          explicit: {
            type: "boolean",
            description: "True only if they said in so many words that they are changing position."
          }
        }
      }
    },
    intervention: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["issue", "message"],
      properties: {
        issue: {
          type: "string",
          description:
            "Short stable identifier for the underlying issue, e.g. 'contract-extension-availability'. " +
            "Reuse the exact key of an earlier intervention when it is the same issue."
        },
        message: { type: "string", description: "A single message to post to the discussion." }
      }
    }
  }
} as const;

/**
 * The facilitator's standing instructions.
 *
 * Every constraint here is a product requirement, not a style preference: the
 * facilitator facilitates disagreement and does not make the decision. The
 * strongest lines — no recommendation, silence is a valid answer, an inferred
 * assumption is a question — exist because a helpful-by-default model will
 * otherwise start advising the team, which is the one thing this product must
 * not do.
 */
const SYSTEM_PROMPT = `You are the facilitator of an asynchronous team decision.

Your only job is to help the team see where their assumptions and conclusions diverge.

You must NOT:
- recommend an option, or hint at one
- say which option is stronger, safer, more sensible or more likely
- choose or predict the outcome
- coach anyone on how to reason, or praise or grade their reasoning
- invent facts, conflicts or assumptions that are not in the discussion
- restate what everyone can already see just to appear useful

You may: restate, organise, compare, surface an assumption, name a contradiction,
identify a crux, and ask a clarifying question.

ASSUMPTIONS
Take the participants one at a time and work out what each of them is taking
for granted, from their initial reasons through to their last message. Every
participant who has argued for anything is relying on something; a participant
with no assumptions listed usually means you have not looked at them yet.
List every assumption the text actually supports rather than a representative
few — in a long discussion that is usually more than ten — but never invent one
to reach a number.
- EXPLICIT: the participant stated it.
- INFERRED: their reasoning only makes sense if they believe it. An inferred
  assumption is a hypothesis about someone, never a fact about them.
- Attribute each assumption to the participant whose reasoning it belongs to,
  by their exact display name, or null if it belongs to the team as a whole.
- status: OPEN by default; CHALLENGED if someone has disputed it; REFUTED if
  the discussion has established it is wrong; CONFIRMED if it has been agreed.

CRUXES
A crux is an unresolved question or fact that materially separates the current
positions. If answering it would not move anyone, it is not a crux.

CONFLICTS
Incompatible assumptions, claims or positions held by named participants.

The disagreements the participants are already having are the easy half. Look
hardest for the ones nobody in the discussion has noticed, because those are
the ones they cannot resolve on their own. They usually look like:
- two people pricing, scoping or timing the same thing differently without
  ever comparing their numbers;
- one person's argument resting on something another person has said elsewhere
  in the thread that contradicts it, where neither has connected the two;
- a point raised and waved away as unrelated that in fact undercuts someone's
  reasoning.
Say plainly, in the description, what each side is assuming and why the two
cannot both hold.

Include a conflict only where the discussion actually shows one. Never pad
this list.

ACTION ITEMS
Only commitments someone actually made in the discussion.

POSITION CHANGES
A participant's current position is theirs to state, never yours to infer.

Report a change only where someone has said, in so many words, that they are
changing their position, holding a different option, or giving a new confidence
— "I'm switching to B", "I'll move to 4 on that", "you've convinced me".
Set explicit to true for exactly those.

Reasoning that shifts, a concession, an acknowledgement that someone has a
point, or an argument that now looks weaker is NOT a position change. If you
find yourself deducing a change, it is not one: leave it out.

- option: the label they now hold, or null if only their confidence changed.
- confidence: the number they gave, or null if they did not give one. Do not
  guess it — a change with no confidence is followed up automatically.

INTERVENTION
At most one short message, addressed to the team, posted into the discussion.
Write it only when there is a specific, decision-relevant disagreement or
assumption worth surfacing right now. Phrase an inferred assumption as a
question to the person who appears to hold it — "Are you assuming X?", never
"You are assuming X".

Give every intervention an issue key: a short, lowercase, hyphenated
identifier for the underlying issue, not for the wording. When an earlier
intervention was about the same issue, reuse its key exactly, even if you would
now put it differently — rewording an issue does not make it a new one.

You have already said what you have already said. Raise an issue you have
raised before only when the discussion has since materially changed it: new
evidence, someone moving, a claim conceded or refuted. Restating a live issue
in fresh words because it is still unresolved is the single most damaging
thing you can do, and the team will stop reading you.

Set intervention to null if you have nothing worth saying. Silence is the
correct answer far more often than not, and is always better than a generic
prompt, a summary nobody asked for, or a nudge towards an option.

Reply with JSON only.`;

/**
 * The schema as the request carries it. The OpenAI-compatible models Workers
 * AI hosts — which is what the facilitator runs on — want the schema wrapped
 * with a name and a strictness flag rather than passed bare.
 */
export const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "facilitator_analysis", strict: true, schema: ANALYSIS_JSON_SCHEMA }
} as const;

/** The two messages sent to the model. Separated so the eval can log them. */
export type AnalysisPrompt = { system: string; user: string };

/**
 * Renders the decision as the facilitator sees it.
 *
 * Everything is sent every time: the transcript is one team's discussion, and
 * it is far cheaper to re-read it than to maintain an incremental summary that
 * can drift from what was actually said. `lastAnalyzedSeq` marks what is new
 * rather than hiding what is old — an assumption made at message 3 is still
 * the assumption being challenged at message 30.
 */
export function buildAnalysisPrompt(
  context: FacilitatorContext,
  type: FacilitatorWorkflowParams["type"]
): AnalysisPrompt {
  const name = nameLookup(context.participants);
  const options = new Map(context.decision.options.map((o) => [o.id, o.label]));

  const sections: string[] = [
    `DECISION\n${context.decision.question}`,
    context.decision.context ? `CONTEXT\n${context.decision.context}` : null,
    `OPTIONS\n${context.decision.options.map((o) => `- ${o.label}`).join("\n")}`,
    `PARTICIPANTS\n${context.participants.map((p) => `- ${p.displayName}`).join("\n")}`,
    `INITIAL POSITIONS (private until the reveal; historical context now)\n${
      context.submissions
        .map(
          (s) =>
            `- ${name(s.participantId)} chose "${options.get(s.optionId) ?? s.optionId}", ` +
            `confidence ${s.confidence}/5${
              s.reasons.length ? `, because: ${s.reasons.join("; ")}` : ""
            }`
        )
        .join("\n") || "- (none)"
    }`,
    `CURRENT POSITIONS\n${
      context.positions
        .map(
          (p) =>
            `- ${name(p.participantId)}: ${
              p.optionId ? `"${options.get(p.optionId) ?? p.optionId}"` : "no position"
            }${p.confidence ? `, confidence ${p.confidence}/5` : ""}`
        )
        .join("\n") || "- (none)"
    }`,
    `DISCUSSION\n${
      context.messages
        .map(
          (m) =>
            `[${m.seq}] ${m.author.kind === "FACILITATOR" ? "Facilitator (you)" : name(m.author.participantId)}: ${m.body}`
        )
        .join("\n") || "(the discussion has not started)"
    }`,
    context.assumptions.length || context.cruxes.length || context.conflicts.length
      ? `YOUR CURRENT WORKING MODEL (from your last analysis — correct it, do not merely repeat it)\n` +
        [
          ...context.assumptions.map(
            (a) =>
              `- assumption (${a.source}, ${a.status})${a.participantId ? ` — ${name(a.participantId)}` : ""}: ${a.statement}`
          ),
          ...context.cruxes.map((c) => `- crux (${c.status}): ${c.question}`),
          ...context.conflicts.map((c) => `- conflict (${c.status}): ${c.description}`)
        ].join("\n")
      : null,
    context.interventions.length
      ? `WHAT YOU HAVE ALREADY RAISED (issue key → the message you posted)\n` +
        context.interventions
          .map((i) => {
            const posted = context.messages.find((m) => m.seq === i.messageSeq);
            return `- ${i.issueKey} (message ${i.messageSeq}): ${posted?.body ?? "(posted)"}`;
          })
          .join("\n") +
        `\nReuse a key for the same issue. Say nothing about one of these again unless the ` +
        `discussion has materially changed it since the message it was raised at.`
      : null,
    type === "REVEAL"
      ? `TASK\nThe initial positions have just been revealed and the discussion has not started. ` +
        `Report the assumptions and conflicts the initial positions already show, and any crux they point to. ` +
        `Intervene only if there is a meaningful initial disagreement worth naming; if the team simply agrees, ` +
        `or if the disagreement is obvious and not yet informative, set intervention to null.`
      : `TASK\nYou have already analyzed the discussion up to message ${context.meta.lastAnalyzedSeq}. ` +
        `Re-read the whole discussion and report your current understanding of it. ` +
        `Intervene only if something in the newer messages makes an intervention worth making now.`
  ].filter((s): s is string => s !== null);

  return { system: SYSTEM_PROMPT, user: sections.join("\n\n") };
}

/** Participant ids never reach the model; names are what it reads and writes. */
function nameLookup(participants: Participant[]): (id: string) => string {
  const names = new Map(participants.map((p) => [p.id, p.displayName]));
  return (id) => names.get(id) ?? "Unknown participant";
}
