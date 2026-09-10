import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

/** Workflow input. The Workflow reads state from the Decision Agent; it never
 *  receives or owns the transcript. */
export type FacilitatorWorkflowParams = {
  decisionId: string;
  type: "REVEAL" | "DISCUSSION" | "CLOSING";
};

/**
 * Durable AI execution: model invocation, retry, output validation. Not a
 * system of record — the Decision Agent remains authoritative.
 *
 * M0 establishes only the deployable Workflow binding. The facilitator
 * pipeline is M4.
 */
export class FacilitatorWorkflow extends WorkflowEntrypoint<Env, FacilitatorWorkflowParams> {
  async run(event: WorkflowEvent<FacilitatorWorkflowParams>, step: WorkflowStep) {
    await step.do("not-yet-implemented", async () => {
      console.log(`facilitator workflow ${event.payload.type} for ${event.payload.decisionId}`);
    });
  }
}
