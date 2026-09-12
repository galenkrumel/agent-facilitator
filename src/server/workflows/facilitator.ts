import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { DEFAULT_TEAM_ID } from "../agents/team.ts";
import { completionFrom, parseAnalysis, parseClosingMemo } from "../facilitator/parse.ts";
import {
  buildAnalysisPrompt,
  buildClosingPrompt,
  CLOSING_RESPONSE_FORMAT,
  FACILITATOR_MODEL,
  INFERENCE,
  RESPONSE_FORMAT,
  type AnalysisPrompt
} from "../facilitator/prompt.ts";
import type { DecisionAgent } from "../agents/decision.ts";
import type { ClosedDecisionRecord, ClosingMemo, FacilitatorContext } from "../../shared/types.ts";

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
      await this.close(agent, decisionId, step);
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
        async () =>
          parseAnalysis(await this.infer(buildAnalysisPrompt(context, type), RESPONSE_FORMAT), context)
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
   * The closing memo, and the team history it becomes.
   *
   * A short-lived run scheduled by the close transaction after it committed.
   * The decision is already closed and its outcome is already the owner's, so
   * nothing here is on anyone's path and nothing here can change either: the
   * worst this run can do is fail, which leaves a closed decision with an
   * honest "the memo could not be written" on it.
   *
   * Four steps, because each is separately worth not repeating. The state read
   * in the first cannot go stale between steps the way a discussion analysis's
   * could — the decision is frozen at close, and `applyAnalysis` refuses
   * anything that arrives afterwards — so a run resumed hours later still
   * synthesizes the decision that was actually closed.
   */
  private async close(
    agent: DurableObjectStub<DecisionAgent>,
    decisionId: string,
    step: WorkflowStep
  ): Promise<void> {
    try {
      const context = await step.do(
        "read final decision state",
        async (): Promise<FacilitatorContext> => agent.getFacilitatorContext()
      );

      const memo = await step.do(
        "synthesize the closing memo",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" },
        async (): Promise<ClosingMemo> =>
          parseClosingMemo(
            await this.infer(buildClosingPrompt(context), CLOSING_RESPONSE_FORMAT),
            context
          )
      );

      // The Agent decides whether this is the memo that lands. A replay of
      // this step after it has already succeeded is refused there, not here.
      await step.do("apply the closing memo", async (): Promise<boolean> =>
        agent.applyClosingMemo(memo)
      );

      // Separately durable on purpose: history is written from the memo the
      // Agent committed, so a retry of this step re-reads that rather than
      // re-running the model, and the Team Agent's write is idempotent by
      // decision id in case it is retried after succeeding.
      await step.do("store team history", async (): Promise<void> => {
        const record: ClosedDecisionRecord | null = await agent.getClosedDecisionRecord();
        if (!record) return;
        const team = await getAgentByName(this.env.TeamAgent, DEFAULT_TEAM_ID);
        await team.storeClosedDecision(record);
      });
    } catch (e) {
      // Everything has already been retried by the step that raised this. The
      // decision stays closed and the outcome stays exactly as declared; all
      // that is lost is the memo, and the team is told so.
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`closing synthesis failed for decision ${decisionId}`, e);
      await agent.failClosingMemo(reason);
    }
  }

  /**
   * One Workers AI call, with the prompt and decoding the evaluation scored.
   *
   * Returns the completion untouched. In structured-output mode Workers AI
   * hands back parsed JSON rather than text, and the parsers take either —
   * serialising it here only to parse it again there would be theatre.
   */
  private async infer(
    prompt: AnalysisPrompt,
    format: typeof RESPONSE_FORMAT | typeof CLOSING_RESPONSE_FORMAT
  ): Promise<unknown> {
    const response = await this.env.AI.run(FACILITATOR_MODEL, {
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ],
      ...INFERENCE,
      // Constrained decoding, so the common failure is a wrong answer rather
      // than an unparseable one. The parsers still treat it as untrusted.
      response_format: format
    });

    return completionFrom(response);
  }
}
