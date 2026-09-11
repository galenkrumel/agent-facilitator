/**
 * Turns whatever the model actually said into a `FacilitatorAnalysisResult`,
 * or throws.
 *
 * The model is an untrusted dependency. Everything it returns passes four
 * stages before any of it can reach SQLite:
 *
 *   extract JSON → parse → schema validation → semantic validation
 *
 * Structural problems throw, because a fresh generation is likely to fix them
 * and the Workflow retries the step. Content that is merely unusable — an
 * assumption attributed to someone who is not in this decision — is dropped
 * rather than allowed to fail the whole analysis, since a retry would very
 * likely produce it again.
 *
 * Pure, and free of Cloudflare imports: `npm run eval` scores the same
 * validator the product runs.
 */
import { MAX_MESSAGE_LENGTH, validateMessageBody } from "../domain/messages.ts";
import type {
  AssumptionSource,
  AssumptionStatus,
  Confidence,
  Conflict,
  FacilitatorAnalysisResult,
  FacilitatorContext,
  Intervention
} from "../../shared/types.ts";

/**
 * Bounds on one analysis. Not product rules — a bound on how much state a
 * single model response can push into the Decision Agent. A model that starts
 * listing every sentence in the transcript as an assumption gets truncated
 * rather than filling the board.
 */
export const LIMITS = {
  assumptions: 20,
  cruxes: 10,
  conflicts: 10,
  actionItems: 10,
  positionChanges: 10
} as const;

/** An issue key is an identifier, not a sentence. */
const MAX_ISSUE_KEY_LENGTH = 80;

const SOURCES: AssumptionSource[] = ["EXPLICIT", "INFERRED"];
const ASSUMPTION_STATUSES: AssumptionStatus[] = ["OPEN", "CONFIRMED", "CHALLENGED", "REFUTED"];
const OPEN_CLOSED: Conflict["status"][] = ["OPEN", "RESOLVED"];

/** A statement long enough to be a wall of text is not an assumption. */
const MAX_STATEMENT_LENGTH = 500;

/**
 * Digs the completion out of whatever envelope the runtime wrapped it in.
 *
 * Workers AI returns `{ response }` for its own models and an OpenAI-shaped
 * `{ choices: [{ message: { content } }] }` for the OpenAI ones, through the
 * same binding and the same REST endpoint. Knowing both here is what lets
 * `npm run eval -- --model=…` compare candidate models without either the
 * Workflow or the evaluation growing a per-model branch.
 */
export function completionFrom(response: unknown): unknown {
  if (typeof response === "string") return response;
  if (!isRecord(response)) throw new Error("the model runtime returned no completion");
  if ("response" in response) return response.response;
  const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
  if (isRecord(choice) && isRecord(choice.message)) return choice.message.content;
  // The OpenAI Responses shape: the text is in the last non-reasoning item.
  if (Array.isArray(response.output)) {
    const content = response.output
      .filter(isRecord)
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter(isRecord)
      .map((part) => part.text)
      .filter((text): text is string => typeof text === "string");
    if (content.length) return content.join("");
  }
  throw new Error("the model runtime returned no completion");
}

/**
 * `output` is whatever the model runtime handed back. In structured-output
 * mode Workers AI returns the completion already parsed — the same call
 * without it, or a different runtime, returns text — so both are accepted
 * here rather than being round-tripped through a string somewhere upstream.
 */
export function parseAnalysis(output: unknown, context: FacilitatorContext): FacilitatorAnalysisResult {
  const value = typeof output === "string" ? (JSON.parse(extractJson(output)) as unknown) : output;
  if (!isRecord(value)) throw new Error("the model returned JSON that is not an object");

  // The range analyzed is what was *sent*, not what the model claims to have
  // read: the Decision Agent uses it to reject stale results, so it must come
  // from state the model cannot influence.
  const analyzedThroughSeq = context.messages.reduce((max, m) => Math.max(max, m.seq), 0);
  const resolve = participantResolver(context);

  const assumptions = array(value.assumptions, "assumptions")
    .slice(0, LIMITS.assumptions)
    .map((item, i) => {
      const at = `assumptions[${i}]`;
      const named = optionalString(item.participant, `${at}.participant`);
      return {
        participantId: named === null ? null : resolve(named),
        statement: statement(item.statement, `${at}.statement`),
        source: oneOf(item.source, SOURCES, `${at}.source`),
        status: oneOf(item.status, ASSUMPTION_STATUSES, `${at}.status`),
        firstSeenSeq: analyzedThroughSeq
      };
    })
    // Attributed to someone who is not in this decision: there is nobody to
    // ask about it, so it cannot be an assumption this decision holds.
    .filter(
      (a): a is FacilitatorAnalysisResult["assumptions"][number] => a.participantId !== undefined
    );

  const cruxes = array(value.cruxes, "cruxes")
    .slice(0, LIMITS.cruxes)
    .map((item, i) => ({
      question: statement(item.question, `cruxes[${i}].question`),
      status: oneOf(item.status, OPEN_CLOSED, `cruxes[${i}].status`)
    }));

  const conflicts = array(value.conflicts, "conflicts")
    .slice(0, LIMITS.conflicts)
    .map((item, i) => ({
      description: statement(item.description, `conflicts[${i}].description`),
      // Unknown names are dropped; the conflict itself still stands, since its
      // description is what makes it a conflict.
      participantIds: array(item.participants, `conflicts[${i}].participants`, "string")
        .map((name) => resolve(String(name)))
        .filter((id): id is string => id !== undefined),
      status: oneOf(item.status, OPEN_CLOSED, `conflicts[${i}].status`)
    }));

  const actionItems = array(value.actionItems, "actionItems")
    .slice(0, LIMITS.actionItems)
    .map((item, i) => {
      const owner = optionalString(item.owner, `actionItems[${i}].owner`);
      return {
        description: statement(item.description, `actionItems[${i}].description`),
        ownerParticipantId: owner === null ? null : (resolve(owner) ?? null)
      };
    });

  // A participant's current position is their own to state, so an observation
  // that is not explicit is dropped here rather than being carried into the
  // Agent and ignored there — the one rule that protects it is easier to trust
  // when nothing downstream ever sees an inferred change at all.
  const option = optionResolver(context);
  const positionChanges = array(value.positionChanges, "positionChanges")
    .slice(0, LIMITS.positionChanges)
    .map((item, i) => {
      const at = `positionChanges[${i}]`;
      const named = optionalString(item.participant, `${at}.participant`);
      const label = optionalString(item.option, `${at}.option`);
      return {
        participantId: named === null ? undefined : resolve(named),
        // Null is "unchanged"; a label nobody offered is not a position anyone
        // can hold, and the change is dropped rather than half-applied.
        optionId: label === null ? null : option(label),
        confidence: confidence(item.confidence, `${at}.confidence`),
        explicit: boolean(item.explicit, `${at}.explicit`)
      };
    })
    .filter((c): c is FacilitatorAnalysisResult["positionChanges"][number] => {
      const kept = c.explicit && c.participantId !== undefined && c.optionId !== undefined;
      // A dropped change is a position that did not move, which is a silence
      // nobody can otherwise account for — least of all the participant who
      // said they were changing it.
      if (!kept) {
        console.log(
          `dropped a position change: ${
            !c.explicit ? "not explicit" : c.participantId === undefined ? "unknown participant" : "unknown option"
          }`
        );
      }
      return kept;
    });

  return {
    analyzedThroughSeq,
    assumptions,
    cruxes,
    conflicts,
    actionItems,
    positionChanges,
    intervention: intervention(value.intervention)
  };
}

/**
 * Structured-output mode returns bare JSON, but a model under retry can still
 * wrap it in a code fence or a sentence of preamble. Taking the outermost
 * braces recovers those without accepting arbitrary prose: if what is between
 * them is not JSON, `JSON.parse` throws and the step retries.
 */
function extractJson(raw: string): string {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("the model returned no JSON object");
  return text.slice(start, end + 1);
}

/**
 * Maps a display name to a participant id, or `undefined` when no participant
 * has that name. Case- and space-insensitive because the model copies names
 * out of prose, not out of a database.
 */
function participantResolver(context: FacilitatorContext): (name: string) => string | undefined {
  const byName = new Map(
    context.participants.map((p) => [p.displayName.trim().toLowerCase(), p.id])
  );
  return (name) => byName.get(name.trim().toLowerCase());
}

/**
 * Maps an option label to its id, or `undefined` when the decision has no such
 * option. Matched the way participant names are, and for the same reason: the
 * model reads labels out of the prompt, and ids never reach it.
 */
function optionResolver(context: FacilitatorContext): (label: string) => string | undefined {
  const byLabel = new Map(
    context.decision.options.map((o) => [o.label.trim().toLowerCase(), o.id])
  );
  return (label) => byLabel.get(label.trim().toLowerCase());
}

/** `null` for silence; otherwise an issue key and a message anyone could post. */
function intervention(value: unknown): Intervention | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error("intervention must be an object or null");
  if (typeof value.message !== "string" || !value.message.trim()) return null;
  if (value.message.trim().length > MAX_MESSAGE_LENGTH) {
    throw new Error(`intervention.message exceeds ${MAX_MESSAGE_LENGTH} characters`);
  }

  const key = statement(value.issue, "intervention.issue").toLowerCase();
  if (key.length > MAX_ISSUE_KEY_LENGTH) throw new Error("intervention.issue is too long");

  return {
    // Normalised, because the key is compared: the same issue written
    // "Contract Extension" and "contract extension" is one issue.
    issueKey: key.replace(/\s+/g, "-"),
    // The facilitator's message is held to the same rule as a participant's —
    // it is posted into the same thread by the same insert.
    message: validateMessageBody(value.message)
  };
}

// ---------------------------------------------------------------------------
// Schema validation. Hand-written: the shapes are small, fixed and already
// declared once as the model's JSON schema, and a validator dependency would
// earn its keep only if either of those stopped being true.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(
  value: unknown,
  at: string,
  items: "object" | "string" = "object"
): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${at} must be an array`);
  if (items === "string") return value as Record<string, unknown>[];
  if (!value.every(isRecord)) throw new Error(`${at} must contain objects`);
  return value;
}

function statement(value: unknown, at: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${at} must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_STATEMENT_LENGTH) throw new Error(`${at} is too long`);
  return trimmed;
}

function optionalString(value: unknown, at: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${at} must be a string or null`);
  return value.trim() || null;
}

function boolean(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${at} must be a boolean`);
  return value;
}

/** A confidence the participant actually gave, or null for "they did not". */
function confidence(value: unknown, at: string): Confidence | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`${at} must be an integer 1–5 or null`);
  }
  return value as Confidence;
}

function oneOf<T extends string>(value: unknown, allowed: T[], at: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${at} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}
