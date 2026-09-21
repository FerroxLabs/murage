// EVERY SURFACE OF THE FIRST RUN A PERSON ACTUALLY READS, IN ONE LIST.
//
// THE DEFECT THIS EXISTS FOR. The copy gate (src/lib/first-run-copy.test.ts)
// walked `FIRST_RUN_COPY` and nothing else, and it was written as though that
// were the whole of the first run's words. It is not. `SETUP_CARD_COPY` in
// server/setup-conversation.ts is rendered into the Chief's thread as the
// title and subtitle of every setup card, which is as visible as anything in
// the other file, and no house rule was applied to it at all. A reviewer put
// "Talk to me and I will answer out loud." on the jobs card and 244 tests
// stayed green.
//
// Two surfaces is not the problem; an UNREGISTERED surface is. So this module
// is the register, and it is enforced rather than remembered:
// first-run-surfaces.test.ts imports every non-test module in the first-run
// and setup-card area, walks its exports for prose, and fails any module that
// is neither registered here nor declared below as holding none. A third copy
// table cannot be added to the area without joining the gate or saying, in
// this file, why it does not have to.
//
// This module holds no copy of its own on purpose. It is the list and the
// walk, so that every test applying a house rule has exactly one answer to
// "what does a person read during the first run".

import { SETUP_CARD_COPY } from "../../server/setup-conversation.ts";

import { FIRST_RUN_PHASES } from "./first-run.ts";
import {
  FIRST_RUN_BRIEF_TIME,
  FIRST_RUN_COPY,
  botsEyebrowLine,
  briefButtonLabel,
  briefRanLine,
  foundAgentsLine,
  greetingLine,
  localModelLine,
  signedOutAgentsLine,
} from "./first-run-copy.ts";

/** One string on a screen, and where it came from. */
export interface ReadableString {
  path: string;
  text: string;
}

/**
 * The registered surfaces.
 *
 * Deep, type blind and walked whole: a card added to either of these is
 * covered the moment it exists, without anybody remembering to list it.
 */
export const FIRST_RUN_SURFACES = {
  FIRST_RUN_COPY,
  SETUP_CARD_COPY,
  // THE THIRD SURFACE, FOUND BY THE REGISTER ON ITS FIRST RUN rather than by
  // anybody remembering it. The phase bar's own words (its title, its close
  // control, the state each pill is in, and the sentence read to assistive
  // technology promising the bar stops nothing) were on screen with no house
  // rule applied to them, which is precisely the hole the register exists to
  // close.
  FIRST_RUN_PHASES,
} as const;

/**
 * Modules in the area that hold NO readable first-run copy, each with the
 * reason. A module here that grows prose fails the register test, and a new
 * module in the area that is in neither list fails it too.
 */
export const FIRST_RUN_SURFACE_MODULES: Readonly<Record<string, string>> = {
  "first-run-copy.ts": "surface: FIRST_RUN_COPY",
  "first-run-copy-rules.ts": "the rules themselves; the only strings in it are patterns",
  "setup-conversation.ts": "surface: SETUP_CARD_COPY",
  "first-run-surfaces.ts": "the register itself",
  "first-run-crew.ts": "shapes the crew screen reads; its words come from FIRST_RUN_COPY",
  "first-run-detect.ts": "reads what is installed; says nothing",
  "first-run-flow.ts": "step and screen structure; its words come from FIRST_RUN_COPY",
  "first-run-jobs.ts": "job shapes and requirements; its words come from FIRST_RUN_COPY",
  "first-run-phone.ts": "pairing state; says nothing",
  "first-run.ts": "surface: FIRST_RUN_PHASES",
};

/** Slugs, template names and row ids are wire identifiers and nobody reads
 *  them. Everything else on a row is read by somebody's eyes. */
const IDENTIFIER = /\.(slug|template|id)$/;

export function walkStrings(value: unknown, path: string, into: ReadableString[]): void {
  if (typeof value === "string") {
    into.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${path}[${index}]`, into));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) walkStrings(item, `${path}.${key}`, into);
  }
}

/** Every string held as data on a registered surface. */
export function firstRunStoredStrings(): ReadableString[] {
  const found: ReadableString[] = [];
  for (const [name, surface] of Object.entries(FIRST_RUN_SURFACES)) walkStrings(surface, name, found);
  return found.filter((entry) => !IDENTIFIER.test(entry.path));
}

/**
 * The sentences the modules ASSEMBLE at render time.
 *
 * A sentence built by a formatter is still a sentence on screen, and the
 * formatters are where a rule slips through unnoticed: nothing in the stored
 * data says "12 bots" or "6:30 pm".
 */
export function firstRunAssembledStrings(): ReadableString[] {
  return [
    { path: "foundAgentsLine(one)", text: foundAgentsLine(["Claude Code"]) },
    { path: "foundAgentsLine(two)", text: foundAgentsLine(["Claude Code", "Codex"]) },
    { path: "foundAgentsLine(three)", text: foundAgentsLine(["Claude Code", "Codex", "Fuigo"]) },
    { path: "foundAgentsLine(none)", text: foundAgentsLine([]) },
    { path: "briefRanLine", text: briefRanLine(FIRST_RUN_BRIEF_TIME) },
    { path: "briefRanLine(pm)", text: briefRanLine("18:30") },
    { path: "briefButtonLabel", text: briefButtonLabel(FIRST_RUN_BRIEF_TIME) },
    { path: "greetingLine", text: greetingLine("Sean") },
    { path: "greetingLine(blank)", text: greetingLine("  ") },
    { path: "signedOutAgentsLine(one)", text: signedOutAgentsLine(["Claude Code"]) },
    { path: "signedOutAgentsLine(two)", text: signedOutAgentsLine(["Claude Code", "Codex"]) },
    { path: "signedOutAgentsLine(none)", text: signedOutAgentsLine([]) },
    { path: "localModelLine", text: localModelLine("Qwen3.8-27B", "llama.cpp") },
    { path: "localModelLine(no host)", text: localModelLine("qwen3:8b", "") },
    { path: "localModelLine(none)", text: localModelLine("", "") },
    { path: "agents.signed-out.commandFor", text: FIRST_RUN_COPY.agents["signed-out"].commandFor("Codex") },
    { path: "botsEyebrowLine(0)", text: botsEyebrowLine(0) },
    { path: "botsEyebrowLine(1)", text: botsEyebrowLine(1) },
    { path: "botsEyebrowLine(2)", text: botsEyebrowLine(2) },
    { path: "botsEyebrowLine(3)", text: botsEyebrowLine(3) },
  ];
}

/** Everything a person can read during the first run, stored and assembled. */
export function firstRunReadableStrings(): ReadableString[] {
  return [...firstRunStoredStrings(), ...firstRunAssembledStrings()];
}
