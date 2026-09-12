/**
 * Creates the demonstration decision against a running deployment, over HTTPS,
 * through the operator's creation endpoint — the same path any decision would
 * be created by, and the only one there is.
 *
 *   SEED_TOKEN=… node scripts/seed.ts https://<your-worker>.workers.dev
 *   SEED_TOKEN=… node scripts/seed.ts http://localhost:5173     # npm run dev
 *
 * The target is an argument rather than a default, because seeding writes real
 * state and "which application did I just write to" is not a question anyone
 * should have to answer from memory.
 *
 * What comes back is an ordinary decision part-way through Discuss: two
 * participants who submitted and have been arguing for two days, a third who
 * was invited and has not opened it yet, and a facilitator that starts reading
 * the thread the moment it lands. Nothing about it is a demonstration mode —
 * the application cannot tell this decision from any other, which is the point.
 *
 * Every run creates a new decision. Participant credentials are shown once and
 * only their hashes are kept, so there is no way to re-print the links of an
 * earlier run — seeding twice gives you a second decision rather than a second
 * copy of the first.
 */
import { existsSync } from "node:fs";
import type { FrameDecisionInput } from "../src/server/agents/decision.ts";

/**
 * A disagreement worth facilitating: two people who agree on the facts, read
 * them differently, and are each resting on something they have not said out
 * loud — what "the rewrite" actually has to cover, and whether the deadline is
 * a deadline. Exported so the seeding test can check it hangs together.
 */
export const SCENARIO: FrameDecisionInput = {
  question: "Do we rewrite the billing service, or keep patching it?",
  context:
    "Billing has caused three customer-visible incidents this quarter. " +
    "We need a direction before Q3 planning locks on Friday.",
  options: ["Rewrite it", "Keep patching"],
  // The first is the owner. Alan was invited and has not opened the decision:
  // participation is voluntary, and a link that has never been used is the
  // ordinary state of an invitation, not a broken one.
  participants: ["Ada", "Grace", "Alan"],
  submissions: [
    {
      participant: 0,
      option: 0,
      confidence: 4,
      reasons: [
        "Three incidents this quarter all came back to the same retry path.",
        "Every patch has made that file harder to change."
      ]
    },
    {
      participant: 1,
      option: 1,
      confidence: 5,
      reasons: [
        "We are two people down until August.",
        "The EU tenant migration lands in the same window."
      ]
    }
  ],
  messages: [
    {
      participant: 0,
      minutesAgo: 2880,
      body:
        "I've put us down for a rewrite. Three incidents this quarter, all traced back to the " +
        "same retry logic, and every patch we've shipped has made that file harder to read. " +
        "I think we can have a replacement carrying live traffic inside a quarter."
    },
    {
      participant: 1,
      minutesAgo: 2760,
      body:
        "I don't disagree that the code is bad. I disagree that we have a quarter. We're two " +
        "people down until August and the EU tenant migration lands in the same window. A " +
        "rewrite that slips leaves us running two billing systems over year-end."
    },
    {
      participant: 0,
      minutesAgo: 2700,
      body:
        "The migration is exactly why I want the rewrite first. If we migrate onto the current " +
        "retry logic we'll be debugging both at once in November."
    },
    {
      participant: 1,
      minutesAgo: 1500,
      body:
        "Do we actually know the retry logic caused those incidents? I read the last review as " +
        "a downstream timeout we never configured. If that's right, a rewrite fixes nothing a " +
        "customer would notice."
    },
    {
      participant: 0,
      minutesAgo: 1440,
      body: "Two of the three were the retry path. The third was the timeout you're thinking of."
    },
    {
      participant: 1,
      minutesAgo: 1400,
      body: "Then fixing the retry path is a week of work, not a quarter of it."
    },
    {
      participant: 0,
      minutesAgo: 1200,
      body:
        "A week to patch it for the fifth time. At some point the patching is the cost, not the " +
        "thing we're avoiding."
    },
    {
      participant: 1,
      minutesAgo: 800,
      body:
        "I'd want to know what \"inside a quarter\" is based on. We estimated the invoicing job " +
        "rewrite at six weeks and it took five months."
    },
    {
      participant: 0,
      minutesAgo: 700,
      body:
        "Fair. I'm going off the new service only having to cover the four flows we actually " +
        "bill on. The rest of what's in there is dead."
    },
    {
      participant: 1,
      minutesAgo: 300,
      body:
        "That's the part I don't believe. I'm fairly sure the customer-specific tax rules live " +
        "in exactly the flows you're calling dead."
    }
  ]
};

type SeededDecision = {
  decisionId: string;
  links: { displayName: string; isOwner: boolean; url: string }[];
};

async function main(origin: string, token: string): Promise<void> {
  const response = await fetch(new URL("/admin/decisions", origin), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(SCENARIO)
  });
  if (!response.ok) {
    throw new Error(`${origin} returned ${response.status}: ${(await response.text()).trim()}`);
  }

  const { decisionId, links } = (await response.json()) as SeededDecision;
  const width = Math.max(...links.map((l) => l.displayName.length)) + 8;
  console.log(`  decision ${decisionId} — ${SCENARIO.messages!.length} messages, already in Discuss`);
  console.log("  participant links (shown once — only their hashes are stored):");
  for (const link of links) {
    console.log(`    ${`${link.displayName}${link.isOwner ? " (owner)" : ""}`.padEnd(width)}${link.url}`);
  }
  console.log("  the facilitator is reading the discussion now; give it a minute.");
}

// Guarded so the scenario above stays importable from tests.
if (process.argv[1]?.endsWith("seed.ts")) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const origin = process.argv[2];
  const token = process.env.SEED_TOKEN?.trim();
  if (!origin || !token) {
    console.error(
      "usage: SEED_TOKEN=… node scripts/seed.ts <origin>\n" +
        "  <origin>     the deployment to seed, e.g. https://your-worker.workers.dev\n" +
        "  SEED_TOKEN   the operator token this deployment was given (see README)."
    );
    process.exit(1);
  }
  await main(origin, token);
}
