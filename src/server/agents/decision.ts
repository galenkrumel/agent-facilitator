import { Agent } from "agents";

/**
 * Transactional authority for one active decision: participants, initial
 * submissions, current positions, messages, facilitator state, board
 * projection, visit state.
 *
 * M0 establishes only the deployable Durable Object. The SQLite schema,
 * authentication and `getBootstrap()` are M1.
 */
export class DecisionAgent extends Agent<Env> {}
