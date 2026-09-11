import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { completionFrom, parseAnalysis } from "../facilitator/parse.ts";
import {
  buildAnalysisPrompt,
  FACILITATOR_MODEL,
  INFERENCE,
  RESPONSE_FORMAT
} from "../facilitator/prompt.ts";
import type { FacilitatorContext } from "../../shared/types.ts";

/** Workflow input. The Workflow reads state from the Decision Agent; it never
 *  receives or owns the transcript. */
export type FacilitatorWorkflowParams = {
  decisionId: string;
  type: "REVEAL" | "DISCUSSION" | "CLOSING";
};

/**
 * Durable AI execution: model invocation, retry, output validation.
 *
 * Not a system of record. Every fact it works from is read from the Decision
 * Agent at the start of the run, and the only thing it can do with its
 * conclusions is hand them back to the Agent to be validated and applied. A
 * Workflow that is retried, resumed hours later, or lost entirely changes no
 * decision state by itself.
 *
 * Nothing here is on a participant's critical path. Messages, submissions and
 * the Reveal have all committed before a run is even scheduled, so every
 * failure below ends the same way: the analysis slot is released, the error is
 * recorded, and the discussion carries on without it.
 */
export class FacilitatorWorkflow extends WorkflowEntrypoint<Env, FacilitatorWorkflowParams> {
  async run(event: WorkflowEvent<FacilitatorWorkflowParams>, step: WorkflowStep) {
    const { decisionId, type } = event.payload;
    const agent = await getAgentByName(this.env.DecisionAgent, decisionId);

    if (type === "CLOSING") {
      // M6: the closing memo, written once the owner has declared an outcome.
      // Nothing schedules this yet — closing does not exist.
      await agent.failAnalysis("the closing memo is implemented in M6");
      return;
    }

    try {
      // Read state, analyze, hand the result back: three steps, because each
      // is separately worth not repeating if a later one fails.
      // The annotation is load-bearing: a Durable Object RPC result is also
      // `Disposable`, which a Workflow step will not accept as its own return
      // type. Naming the contract drops the stub's own machinery from it.
      const context = await step.do(
        "read decision state",
        async (): Promise<FacilitatorContext> => agent.getFacilitatorContext()
      );

      // Inference and validation are one step on purpose. Output that does not
      // survive validation is not output — retrying the step generates again,
      // which is the only thing that can fix a malformed response.
      const analysis = await step.do(
        "analyze",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" },
        async () => parseAnalysis(await this.infer(context, type), context)
      );

      await step.do("apply analysis", () => agent.applyAnalysis(analysis));
    } catch (e) {
      // Everything has already been retried by the step that raised this. The
      // decision is untouched; record why and release the slot so the next
      // message can schedule a fresh run.
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`${type} analysis failed for decision ${decisionId}`, e);
      await agent.failAnalysis(reason);
    }
  }

  /**
   * One Workers AI call, with the prompt and decoding the evaluation scored.
   *
   * Returns the completion untouched. In structured-output mode Workers AI
   * hands back parsed JSON rather than text, and `parseAnalysis` takes either
   * — serialising it here only to parse it again there would be theatre.
   */
  private async infer(
    context: FacilitatorContext,
    type: FacilitatorWorkflowParams["type"]
  ): Promise<unknown> {
    const prompt = buildAnalysisPrompt(context, type);
    const response = await this.env.AI.run(FACILITATOR_MODEL, {
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ],
      ...INFERENCE,
      // Constrained decoding, so the common failure is a wrong answer rather
      // than an unparseable one. `parseAnalysis` still treats it as untrusted.
      response_format: RESPONSE_FORMAT
    });

    return completionFrom(response);
  }
}
