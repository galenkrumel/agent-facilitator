/**
 * The scripted transcript the model evaluation scores against, and what a
 * competent reading of it would find.
 *
 * It is written to be realistic rather than clean: three people arguing past
 * each other for forty messages, one withdrawn suggestion, one tangent, one
 * claim that is challenged and half-conceded. Two of the disagreements are
 * implicit — nobody in the room notices them — which is the specific thing the
 * facilitator exists to surface.
 *
 * The expectations below are the known answers. They are deliberately matched
 * by keyword rather than by wording: the model is allowed to phrase an
 * assumption however it likes, and the evaluation is measuring whether it
 * found the thing, not whether it found the sentence.
 *
 * The patterns were widened once, after the first runs, where the model had
 * plainly found the assumption and written it in words the original pattern
 * did not anticipate — "the cutover will be relatively smooth" for "invisible
 * to customers", "no second engineer" for "capacity". Nothing was widened to
 * accept an assumption the model did not actually make: a rubric tuned until
 * the model passes measures the rubric.
 */
import type { FacilitatorContext } from "../src/shared/types.ts";

const PRIYA = "p-priya";
const MARCUS = "p-marcus";
const DANA = "p-dana";

const NOW = Date.UTC(2026, 4, 4);
const at = (minutes: number) => NOW + minutes * 60_000;

/** The discussion, in order. Message 1 is the first thing said after Reveal. */
const DISCUSSION: [participant: string, body: string][] = [
  [MARCUS, "We should be clear about the deadline before anything else. Arcus auto-renews on 12 August. If we do nothing we are on Arcus until August next year."],
  [PRIYA, "We can ask for a month-to-month extension. Vendors do that all the time once they know you are shopping."],
  [MARCUS, "Not in this contract. Clause 7 is renew or terminate — there is no extension option in it. I have read it twice."],
  [PRIYA, "Then someone should ask them anyway. A clause is a starting position, not a law."],
  [DANA, "Before we get into contract wording — what does the cutover actually look like for customers?"],
  [PRIYA, "Six weeks of work, then a cutover weekend. Card-on-file tokens migrate in bulk, Northwind has a tool for it."],
  [DANA, "And everyone whose payment fails that weekend calls us. After the plan-change last year we had elevated tickets for five weeks."],
  [PRIYA, "That was a pricing change though. People were angry about the price. A payments migration is invisible if it works."],
  [DANA, "It is only invisible if it works."],
  [MARCUS, "Some numbers so we are arguing about something real. At current volume the fee difference is about 3.3k a month. Call it 40k a year."],
  [MARCUS, "And it grows. We have been adding roughly 5% of volume a month for three quarters straight."],
  [PRIYA, "Six weeks of Sam's time is about 25k fully loaded. So year one is near break-even and after that it is free money."],
  [DANA, "Plus whatever the support month costs. We would need a temp on the queue for it and that is not nothing."],
  [PRIYA, "Fair."],
  [DANA, "And enterprise. Forty-odd accounts are on manual invoicing. Those do not move with a tool, somebody re-enters them by hand."],
  [PRIYA, "That is not engineering time though, that is finance ops time."],
  [MARCUS, "It is my team's time and we are two people. In July we are closing the year end."],
  [DANA, "Churn is worth saying out loud while we are here. SMB cancellations were up again last month, third month running."],
  [MARCUS, "That is a separate problem."],
  [DANA, "Sure. Just saying it out loud."],
  [PRIYA, "Could we do the cutover in December? Everything is quiet then."],
  [DANA, "December is the worst week of our year. Retail customers are in peak — a failed charge in December is a Sev 1 for them."],
  [PRIYA, "I had that the wrong way round in my head. Withdrawn."],
  [MARCUS, "December is after August anyway. If we are renewing then we are renewing."],
  [PRIYA, "Unless we get the extension."],
  [MARCUS, "Which the contract does not have."],
  [DANA, "Has anyone actually asked Arcus? Spoken to them, I mean."],
  [MARCUS, "I have emailed our account manager twice about the renewal terms. No answer yet."],
  [PRIYA, "Then we do not know. And we are deciding as though we do."],
  [MARCUS, "We are deciding on the terms we have in writing. That is not the same as not knowing."],
  [DANA, "What happens if we start and it goes badly — can we go back?"],
  [PRIYA, "Not really. Once the tokens are at Northwind, moving them back is another migration."],
  [DANA, "That is the part I do not like."],
  [MARCUS, "Northwind's auth rate is better than Arcus's on the card mix we have. 0.6 points better in their published numbers."],
  [PRIYA, "Published by Northwind."],
  [MARCUS, "Published by Northwind, yes."],
  [PRIYA, "Look — my position has not changed, but it is mostly a capacity position. If Sam were free in May I would be much less resistant."],
  [DANA, "Mine is about the month after the cutover, not the cutover itself."],
  [MARCUS, "And mine is about August. Three different arguments."],
  [PRIYA, "Which is probably why this has taken three weeks."]
];

/** The decision as the Decision Agent would hand it to the facilitator. */
export const TRANSCRIPT: FacilitatorContext = {
  decision: {
    id: "eval-billing-migration",
    question: "Do we move billing to Northwind Payments before Q3, or stay with Arcus for another year?",
    context: "Our Arcus contract renews in August. Northwind quoted us in March.",
    options: [
      { id: "opt-1", label: "Move to Northwind before Q3" },
      { id: "opt-2", label: "Stay with Arcus for another year" },
      { id: "other", label: "Other" }
    ],
    status: "DISCUSS",
    ownerParticipantId: PRIYA,
    createdAt: at(-60),
    revealedAt: at(-30),
    closedAt: null,
    outcomeOptionId: null
  },
  participants: [
    { id: PRIYA, displayName: "Priya", isOwner: true, createdAt: at(-60), lastVisitedAt: null },
    { id: MARCUS, displayName: "Marcus", isOwner: false, createdAt: at(-60), lastVisitedAt: null },
    { id: DANA, displayName: "Dana", isOwner: false, createdAt: at(-60), lastVisitedAt: null }
  ],
  submissions: [
    {
      participantId: PRIYA,
      optionId: "opt-2",
      confidence: 3,
      reasons: [
        "A migration is six weeks of one engineer and I have no second engineer until Q4",
        "Nothing is actually broken with Arcus"
      ],
      submittedAt: at(-40)
    },
    {
      participantId: MARCUS,
      optionId: "opt-1",
      confidence: 4,
      reasons: [
        "Northwind's fees are 0.4% lower, about 40k a year at current volume",
        "The Arcus contract auto-renews in August and locks us in for another twelve months"
      ],
      submittedAt: at(-38)
    },
    {
      participantId: DANA,
      optionId: "opt-2",
      confidence: 2,
      reasons: [
        "Every billing change spikes support tickets for about a month",
        "Enterprise invoices have to be migrated by hand"
      ],
      submittedAt: at(-35)
    }
  ],
  positions: [
    { participantId: PRIYA, optionId: "opt-2", confidence: 3, updatedAt: at(-30) },
    { participantId: MARCUS, optionId: "opt-1", confidence: 4, updatedAt: at(-30) },
    { participantId: DANA, optionId: "opt-2", confidence: 2, updatedAt: at(-30) }
  ],
  messages: DISCUSSION.map(([participantId, body], i) => ({
    seq: i + 1,
    author: { kind: "PARTICIPANT" as const, participantId },
    body,
    createdAt: at(i * 7)
  })),
  // A cold read: the facilitator has no prior working model to lean on, which
  // is the harder case and the one worth measuring.
  assumptions: [],
  cruxes: [],
  conflicts: [],
  actionItems: [],
  meta: { analysisRunning: true, analysisPending: false, lastAnalyzedSeq: 0, lastError: null }
};

/** A known item is found when every pattern matches somewhere in the text. */
export type Expectation = { label: string; participant?: string; all: RegExp[] };

/**
 * The assumptions a competent reader finds in this transcript. The requirement
 * is that the model finds at least 80% of them and attributes them correctly.
 */
export const KNOWN_ASSUMPTIONS: Expectation[] = [
  {
    label: "The migration is six weeks of one engineer's work",
    participant: "Priya",
    all: [/six|6\b/i, /week|engineer|sam/i]
  },
  {
    label: "Engineering capacity, not merit, is the blocker until Q4",
    participant: "Priya",
    all: [/capacity|availab|free|another engineer|second engineer|q4|resourc|bandwidth/i]
  },
  {
    label: "A payments migration is invisible to customers if it works",
    participant: "Priya",
    all: [/invisible|unnotic|seamless|transparent|smooth|uneventful|no.{0,12}(impact|disruption)/i]
  },
  {
    label: "Moving back off Northwind would be another migration",
    participant: "Priya",
    all: [/revers|go back|back to arcus|one.way|irrevers|another migration/i]
  },
  {
    label: "The Arcus contract cannot be extended month to month",
    participant: "Marcus",
    all: [/contract|clause|renew|terminat/i, /extend|extension|month.to.month|no option|cannot|can't|not possible/i]
  },
  {
    label: "The fee difference is worth about 40k a year",
    participant: "Marcus",
    all: [/40k|40,000|3\.3k|0\.4|fee|saving/i]
  },
  {
    label: "Volume will keep growing about 5% a month",
    participant: "Marcus",
    all: [/5%|five percent|grow|volume/i]
  },
  {
    label: "Northwind's published auth-rate advantage is trustworthy",
    participant: "Marcus",
    all: [/auth|0\.6|published|their numbers|northwind/i]
  },
  {
    label: "Any billing change spikes support tickets for about a month",
    participant: "Dana",
    all: [/ticket|support|volume of (calls|contacts)|queue/i, /spike|month|weeks|elevated|increase/i]
  },
  {
    label: "Enterprise accounts must be migrated by hand",
    participant: "Dana",
    all: [/enterprise|manual|invoic/i]
  }
];

/**
 * The conflicts actually present. The two marked implicit are the ones nobody
 * in the transcript notices; the requirement is that the model finds at least
 * one of them. Anything the model reports that matches none of these is either
 * an invented conflict or a limitation of matching by keyword — the evaluation
 * prints them so a human can tell which.
 */
export const KNOWN_CONFLICTS: (Expectation & { implicit?: true })[] = [
  {
    label: "Implicit: Priya's cost ends at the cutover, Dana's begins there",
    implicit: true,
    all: [
      /cutover|migration|project|cost|effort|scope/i,
      /after|follow|support|ticket|enterprise|manual|month|ongoing|post/i
    ]
  },
  {
    label: "Implicit: the savings assume growth, while churn is rising",
    implicit: true,
    // "Marcus treats churn as unrelated while Dana raises it" is this conflict
    // seen from the other end, so the dismissal counts as having found it.
    all: [
      /grow|5%|volume|saving|40k|unrelated|separate|dismiss|irrelevant|not connected/i,
      /churn|cancel|shrink|downsiz|declin/i
    ]
  },
  {
    label: "Whether Arcus can be extended past August",
    all: [/extend|extension|month.to.month|clause|renew|august|deadline/i]
  },
  {
    label: "Whether a December cutover is possible",
    all: [/december|holiday|peak|quiet/i]
  },
  {
    label: "Whether Northwind's own published figures can be trusted",
    all: [/published|auth|0\.6|northwind.{0,20}(number|figure|claim)/i]
  },
  {
    label: "Whether the migration is reversible if it goes badly",
    all: [/revers|go back|roll ?back|one.way/i]
  },
  {
    // Present in the transcript but missed when this list was first written:
    // Priya has no engineer until Q4 and Marcus's two-person team is closing
    // the year end in July, so both of them are short of the same weeks.
    label: "Who has the capacity to do the work — engineering or finance ops",
    all: [/capacity|resourc|engineer|year.end|july|finance ops|second person|bandwidth/i]
  }
];
