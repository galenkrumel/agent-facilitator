import { Agent } from "agents";

/**
 * Owns closed decision history: closing memos and significant historical
 * assumptions. Never holds active decision state.
 *
 * M0 establishes only the deployable Durable Object. Storage is M6.
 */
export class TeamAgent extends Agent<Env> {}
