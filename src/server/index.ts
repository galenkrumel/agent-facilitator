import { getAgentByName, routeAgentRequest } from "agents";
import type { FrameDecisionInput } from "./agents/decision.ts";
import { DEFAULT_TEAM_ID } from "./agents/team.ts";
import { bearerToken, matchesSecret } from "./auth/credentials.ts";
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

    // End-to-end verification infrastructure, not a product API. It is how
    // `scripts/verify.ts` reads back what the closing Workflow wrote to the
    // Team Agent, which is otherwise unreachable over the wire — and
    // deliberately so: the Team Agent has no participant or session model, so
    // nothing it holds may be exposed to a browser.
    //
    // `import.meta.env.DEV` is a build-time constant, so this branch is
    // eliminated from the deployed Worker rather than merely refused there.
    // It is the last route guarded that way: decision creation is no longer a
    // development fixture but an authenticated operator endpoint, below.
    if (import.meta.env.DEV && root === "team" && decisionId === "history" && p) {
      const team = await getAgentByName(env.TeamAgent, DEFAULT_TEAM_ID);
      const record = await team.getClosedDecision(p);
      return record ? Response.json(record) : new Response("Not found", { status: 404 });
    }

    // The operator's decision-creation path, and the whole of the
    // administrative surface: one operation, no reads, no listing, no deletes.
    //
    // Deliberately not a product API. The plan (§4.1) rejects a public
    // creation endpoint, so this one is for whoever deploys and seeds the
    // application, authenticated by a Worker secret that no browser is ever
    // given. What it creates is an ordinary decision — participants reach it
    // through the same participant links, and nothing downstream knows it was
    // created here rather than by a person.
    if (root === "admin" && decisionId === "decisions" && !p && request.method === "POST") {
      return createDecision(request, env, url);
    }

    if (root === "d") {
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

/**
 * Creates one decision, for the operator who deployed the application.
 *
 * The bearer token is compared as a hash of itself, so the comparison takes
 * the same time whatever is presented and a near-miss is worth no more than a
 * wild guess. The token is never echoed, logged, or written anywhere: the only
 * thing that leaves here is the decision and its participant links.
 */
async function createDecision(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.SEED_TOKEN) {
    // Distinguished from a refusal on purpose. An operator who has not set the
    // secret has a configuration problem, and telling them so costs nothing —
    // the endpoint is unusable either way until they do.
    return new Response("Administrative decision creation is not configured on this deployment.", {
      status: 503
    });
  }
  if (!(await matchesSecret(bearerToken(request), env.SEED_TOKEN))) {
    return new Response("Unauthorized", { status: 401 });
  }

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
