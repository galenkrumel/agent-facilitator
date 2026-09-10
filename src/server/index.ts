import { routeAgentRequest } from "agents";

export { DecisionAgent } from "./agents/decision.ts";
export { TeamAgent } from "./agents/team.ts";
export { FacilitatorWorkflow } from "./workflows/facilitator.ts";

// The Worker stays thin: it routes Agents SDK traffic and, from M1, resolves
// participant links into browser-local sessions. It holds no decision state.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
