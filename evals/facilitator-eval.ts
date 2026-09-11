/**
 * Model evaluation. Runs the scripted transcript through the real facilitator
 * prompt, against the real model, and scores what comes back.
 *
 *   npm run eval                      # three runs, the model the product uses
 *   npm run eval -- --runs=5
 *   npm run eval -- --show            # also print the first run in full
 *   npm run eval -- --model=@cf/…     # score a candidate model instead
 *
 * This exists to answer one question before the facilitator is built on top of
 * a model: is it good enough at this task? The requirements set the bar — 80%
 * of the known assumptions, attributed to the right person, at least one of the
 * two implicit conflicts, no invented conflicts, and structured output that
 * parses without having to be retried.
 *
 * Llama 3.3, which the requirements name, did not clear it: 57% recall. See the
 * README for the comparison that selected the model now in `prompt.ts`.
 *
 * It runs from Node against the Workers AI REST endpoint rather than inside a
 * Worker, but the prompt, the decoding parameters and the validator are
 * imported from `src/` — the product and the evaluation cannot drift, because
 * they are the same code with a different transport.
 */
import { existsSync } from "node:fs";
import { completionFrom, parseAnalysis } from "../src/server/facilitator/parse.ts";
import {
  buildAnalysisPrompt,
  FACILITATOR_MODEL,
  INFERENCE,
  RESPONSE_FORMAT
} from "../src/server/facilitator/prompt.ts";
import { KNOWN_ASSUMPTIONS, KNOWN_CONFLICTS, TRANSCRIPT, type Expectation } from "./transcript.ts";
import type { FacilitatorAnalysisResult } from "../src/shared/types.ts";

/** The bars from the requirements, and how this script reads each of them. */
const CRITERIA = {
  /** Mean fraction of the known assumptions the model found. */
  assumptionRecall: 0.8,
  /** Of the assumptions it found, the fraction pinned on the right person. */
  attributionAccuracy: 0.9,
  /** Runs that must surface at least one of the two implicit conflicts. */
  implicitConflictRuns: 0.5,
  /** Reported conflicts per run that match nothing in the transcript. */
  maxUnrecognisedConflicts: 1
};

type RunResult = {
  analysis: FacilitatorAnalysisResult | null;
  error: string | null;
  found: boolean[];
  attributed: boolean[];
  implicit: boolean[];
  unrecognised: string[];
  intervention: string | null;
  ms: number;
};

const NAMES = new Map(TRANSCRIPT.participants.map((p) => [p.id, p.displayName]));

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) {
    console.error(
      "✗ CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set.\n" +
        "  Copy .env.example to .env and fill them in. The token needs Account → Workers AI → Read."
    );
    process.exit(1);
  }

  const runs = Number(arg("runs") ?? 3);
  const model = arg("model") || FACILITATOR_MODEL;
  const prompt = buildAnalysisPrompt(TRANSCRIPT, "DISCUSSION");

  console.log(`Model:      ${model}${model === FACILITATOR_MODEL ? "" : "  (candidate)"}`);
  console.log(`Transcript: ${TRANSCRIPT.messages.length} messages, ${TRANSCRIPT.participants.length} participants`);
  console.log(`Known:      ${KNOWN_ASSUMPTIONS.length} assumptions, ${KNOWN_CONFLICTS.length} conflicts (2 implicit)`);
  console.log(`Runs:       ${runs}\n`);

  const results: RunResult[] = [];
  for (let i = 1; i <= runs; i++) {
    process.stdout.write(`▸ run ${i}/${runs} … `);
    const result = await run(accountId, token, model, prompt);
    results.push(result);
    console.log(
      result.error
        ? `failed: ${result.error}`
        : `${(result.ms / 1000).toFixed(1)}s — ` +
          `${count(result.found)}/${KNOWN_ASSUMPTIONS.length} assumptions, ` +
          `${count(result.implicit)}/2 implicit conflicts, ` +
          `${result.unrecognised.length} unrecognised, ` +
          `${result.intervention ? "intervened" : "silent"}`
    );
  }

  report(results, model, arg("show") !== undefined);
  process.exit(verdict(results) ? 0 : 1);
}

/** One inference, parsed through the product's own validator, then scored. */
async function run(
  accountId: string,
  token: string,
  model: string,
  prompt: { system: string; user: string }
) {
  const started = Date.now();
  const result: RunResult = {
    analysis: null,
    error: null,
    found: KNOWN_ASSUMPTIONS.map(() => false),
    attributed: KNOWN_ASSUMPTIONS.map(() => false),
    implicit: [false, false],
    unrecognised: [],
    intervention: null,
    ms: 0
  };

  try {
    const raw = await infer(accountId, token, model, prompt);
    const analysis = parseAnalysis(raw, TRANSCRIPT);
    result.analysis = analysis;
    result.intervention = analysis.intervention;
    score(analysis, result);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  result.ms = Date.now() - started;
  return result;
}

/**
 * Workers AI over HTTP. Deliberately the same model, prompt and decoding
 * parameters the Workflow uses through the `AI` binding — only the transport
 * differs, because Node has no binding to call.
 */
async function infer(
  accountId: string,
  token: string,
  model: string,
  prompt: { system: string; user: string }
): Promise<unknown> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ],
        ...INFERENCE,
        response_format: RESPONSE_FORMAT
      })
    }
  );

  const body = (await response.json()) as {
    success?: boolean;
    result?: unknown;
    errors?: { code: number; message: string }[];
  };
  if (!response.ok || !body.success) {
    const detail = body.errors?.map((e) => `${e.code} ${e.message}`).join("; ");
    throw new Error(`Workers AI returned ${response.status}${detail ? ` — ${detail}` : ""}`);
  }
  // The same envelope-unwrapping the Workflow does, so a candidate model is
  // scored on exactly the path it would run on in production.
  return completionFrom(body.result);
}

// ---------------------------------------------------------------------------
// Scoring

function score(analysis: FacilitatorAnalysisResult, result: RunResult) {
  KNOWN_ASSUMPTIONS.forEach((known, i) => {
    // Every match, not the first: a model that lists an assumption twice, or
    // splits it across two statements, should be judged on whether it got the
    // attribution right anywhere — not on which one happened to come first.
    const hits = analysis.assumptions.filter((a) => matches(known, a.statement));
    result.found[i] = hits.length > 0;
    result.attributed[i] = hits.some(
      (hit) =>
        known.participant === undefined ||
        (hit.participantId !== null && NAMES.get(hit.participantId) === known.participant)
    );
  });

  // An implicit conflict counts as surfaced whether the model reported it as a
  // conflict or as the crux it points to — both are it having seen the thing.
  const surfaced = [
    ...analysis.conflicts.map((c) => c.description),
    ...analysis.cruxes.map((c) => c.question)
  ];
  const implicit = KNOWN_CONFLICTS.filter((c) => c.implicit);
  result.implicit = implicit.map((known) => surfaced.some((text) => matches(known, text)));

  // Conflicts that match nothing known. Either invented, or worded in a way
  // these keywords miss — printed in full so a human can tell which.
  result.unrecognised = analysis.conflicts
    .filter((c) => !KNOWN_CONFLICTS.some((known) => matches(known, c.description)))
    .map((c) => c.description);
}

const matches = (expectation: Expectation, text: string) =>
  expectation.all.every((pattern) => pattern.test(text));

const count = (flags: boolean[]) => flags.filter(Boolean).length;
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/** The measured numbers, as the criteria read them. */
function measure(results: RunResult[]) {
  const ok = results.filter((r) => r.analysis);
  return {
    validOutput: ok.length,
    assumptionRecall: mean(ok.map((r) => count(r.found) / KNOWN_ASSUMPTIONS.length)),
    attributionAccuracy: mean(
      ok.filter((r) => count(r.found) > 0).map((r) => count(r.attributed) / count(r.found))
    ),
    implicitConflictRuns: ok.length ? ok.filter((r) => r.implicit.some(Boolean)).length / ok.length : 0,
    unrecognised: mean(ok.map((r) => r.unrecognised.length))
  };
}

function verdict(results: RunResult[]): boolean {
  const m = measure(results);
  return (
    m.validOutput === results.length &&
    m.assumptionRecall >= CRITERIA.assumptionRecall &&
    m.attributionAccuracy >= CRITERIA.attributionAccuracy &&
    m.implicitConflictRuns >= CRITERIA.implicitConflictRuns &&
    m.unrecognised <= CRITERIA.maxUnrecognisedConflicts
  );
}

function report(results: RunResult[], model: string, show: boolean) {
  const m = measure(results);
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  console.log("\nPer known assumption (found / attributed), across runs:");
  KNOWN_ASSUMPTIONS.forEach((known, i) => {
    const found = results.filter((r) => r.found[i]).length;
    const attributed = results.filter((r) => r.attributed[i]).length;
    console.log(
      `  ${found === results.length ? "✓" : found === 0 ? "✗" : "~"} ` +
        `${String(found).padStart(2)}/${results.length} found, ` +
        `${String(attributed).padStart(2)}/${results.length} to ${known.participant ?? "anyone"}  ` +
        known.label
    );
  });

  console.log("\nImplicit conflicts (the two nobody in the transcript notices):");
  KNOWN_CONFLICTS.filter((c) => c.implicit).forEach((known, i) => {
    const runs = results.filter((r) => r.implicit[i]).length;
    console.log(`  ${runs > 0 ? "✓" : "✗"} ${runs}/${results.length} runs  ${known.label}`);
  });

  const unrecognised = results.flatMap((r) => r.unrecognised);
  if (unrecognised.length) {
    console.log("\nConflicts matching nothing known — read these, they may be invented:");
    for (const text of unrecognised) console.log(`  · ${text}`);
  }

  console.log("\nInterventions — read these for neutrality; the facilitator must not advise:");
  results.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.intervention ? r.intervention.replace(/\s+/g, " ") : "(silent)"}`);
  });

  const line = (pass: boolean, label: string, value: string) =>
    console.log(`  ${pass ? "✓" : "✗"} ${label.padEnd(34)} ${value}`);
  console.log("\nCriteria:");
  line(m.validOutput === results.length, "valid structured output, no retry", `${m.validOutput}/${results.length} runs`);
  line(m.assumptionRecall >= CRITERIA.assumptionRecall, "assumption recall ≥ 80%", pct(m.assumptionRecall));
  line(m.attributionAccuracy >= CRITERIA.attributionAccuracy, "attribution accuracy ≥ 90%", pct(m.attributionAccuracy));
  line(m.implicitConflictRuns >= CRITERIA.implicitConflictRuns, "≥1 implicit conflict, ≥half the runs", pct(m.implicitConflictRuns));
  line(m.unrecognised <= CRITERIA.maxUnrecognisedConflicts, "unrecognised conflicts ≤ 1 per run", m.unrecognised.toFixed(1));

  for (const r of results) if (r.error) console.log(`\n  failure: ${r.error}`);
  if (show && results[0]?.analysis) {
    console.log(`\nFirst run, in full:\n${JSON.stringify(results[0].analysis, null, 2)}`);
  }

  console.log(
    verdict(results)
      ? `\n✓ ${model} meets the bar for the facilitator.`
      : `\n✗ ${model} does not meet the bar. Evaluate another model before building on it.`
  );
}

/** `--runs=5`, or `--show` as a bare flag. */
function arg(name: string): string | undefined {
  const found = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  return found === undefined ? undefined : (found.split("=")[1] ?? "");
}

await main();
