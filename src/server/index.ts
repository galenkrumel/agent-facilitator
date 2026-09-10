import { getAgentByName, routeAgentRequest } from "agents";
import type { FrameDecisionInput } from "./agents/decision.ts";
import { DECISION_ID_PATTERN, sessionCookie } from "./auth/sessions.ts";

export { DecisionAgent } from "./agents/decision.ts";
export { TeamAgent } from "./agents/team.ts";
export { FacilitatorWorkflow } from "./workflows/facilitator.ts";

/**
 * The Worker stays thin: it resolves participant links into browser-local
 * sessions, serves the SPA, and routes Agents SDK traffic. It holds no
 * decision state and makes no decisions about it — every mutation happens
 * inside the Decision Agent.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [root, decisionId, p, credential] = url.pathname.split("/").filter(Boolean);

    if (root === "d") {
      // Frame a decision. Unauthenticated by design: there are no accounts,
      // and framing only yields links to the decision you just created.
      // `new` cannot collide with a decision id — those are UUIDs.
      if (decisionId === "new" && request.method === "POST") {
        return frameDecision(request, env, url);
      }
      if (decisionId && !DECISION_ID_PATTERN.test(decisionId)) {
        return new Response("Not found", { status: 404 });
      }
      // The participant link. Exchanged once for a session cookie, then
      // redirected so the credential leaves the address bar — but the link
      // stays reusable, from any browser, for the life of the decision.
      if (decisionId && p === "p" && credential) {
        const agent = await getAgentByName(env.DecisionAgent, decisionId);
        const sessionId = await agent.startSession(credential);
        if (!sessionId) return new Response("This participant link is not valid.", { status: 404 });
        return new Response(null, {
          status: 303,
          headers: { Location: `/d/${decisionId}`, "Set-Cookie": sessionCookie(decisionId, sessionId) }
        });
      }
      // Any other /d/... path is a decision view: serve the SPA shell.
      return env.ASSETS.fetch(request);
    }

    return (
      (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

async function frameDecision(request: Request, env: Env, url: URL): Promise<Response> {
  let input: FrameDecisionInput;
  try {
    input = (await request.json()) as FrameDecisionInput;
  } catch {
    return new Response("Expected a JSON body", { status: 400 });
  }
  if (!Array.isArray(input?.options) || !Array.isArray(input?.participants)) {
    return new Response("Expected { question, context?, options[], participants[] }", { status: 400 });
  }

  const decisionId = crypto.randomUUID();
  const agent = await getAgentByName(env.DecisionAgent, decisionId);
  try {
    const framed = await agent.frameDecision(input);
    return Response.json({
      decisionId,
      // Shown once. Only hashes are stored, so these cannot be recovered later.
      links: framed.map((f) => ({
        displayName: f.displayName,
        isOwner: f.isOwner,
        url: `${url.origin}/d/${decisionId}/p/${f.credential}`
      }))
    });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "Could not frame decision", { status: 400 });
  }
}
