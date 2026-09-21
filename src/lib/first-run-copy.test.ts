import { describe, expect, it } from "vitest";

import { fluxRecommendation } from "@/components/FirstRunFluxCard";
import {
  FIRST_RUN_BRIEF_TIME,
  FIRST_RUN_COPY,
  briefButtonLabel,
  briefRanLine,
  clockLabel,
  foundAgentsLine,
  greetingLine,
  localModelLine,
  signedOutAgentsLine,
  joinNames,
} from "./first-run-copy";

/**
 * THE COPY GATE.
 *
 * Every string a person can read during the first run is in one module, so
 * the rules the product owner has rejected work over can be checked over all
 * of it at once rather than argued about per pull request. A rule that lives
 * only in a brief is a rule that comes back.
 *
 * The walk is deep and type blind on purpose: a new card added to
 * FIRST_RUN_COPY is covered the moment it exists, without anyone remembering
 * to add it here. Strings produced by the module's formatters are fed in
 * beside it, because a sentence assembled at render time is still a sentence
 * on screen.
 */
function walk(value: unknown, path: string, into: Array<{ path: string; text: string }>): void {
  if (typeof value === "string") {
    into.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, into));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, into);
  }
}

const strings: Array<{ path: string; text: string }> = [];
walk(FIRST_RUN_COPY, "FIRST_RUN_COPY", strings);
// Slugs, template names and row ids are wire identifiers and nobody reads
// them. Everything else on a row is read out loud by somebody's eyes.
//
// `.id` earns its place here rather than being an oversight: the Flux row
// keyed `voice` is a React key and a stable handle for the row, and a rule
// about what a person may be TOLD has no business failing because of the word
// an array is keyed by. What the person actually reads is `title` and `body`,
// and both of those stay in the walk.
const IDENTIFIER = /\.(slug|template|id)$/;
const readable = strings.filter((entry) => !IDENTIFIER.test(entry.path));

const assembled: Array<{ path: string; text: string }> = [
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
];

const everything = [...readable, ...assembled];

describe("first run copy: the house rules", () => {
  it("has strings to check at all", () => {
    expect(readable.length).toBeGreaterThan(40);
  });

  it("never uses an em dash", () => {
    for (const { path, text } of everything) {
      expect.soft(`${path}: ${text}`).not.toContain("—");
    }
  });

  it("never uses an en dash as punctuation", () => {
    for (const { path, text } of everything) {
      expect.soft(`${path}: ${text}`).not.toContain("–");
    }
  });

  it("never names the connected app broker", () => {
    for (const { path, text } of everything) {
      expect.soft(`${path}: ${text}`.toLowerCase()).not.toContain("composio");
    }
  });

  it("never sells on price", () => {
    // Money in any form: the adjectives, the nouns, and the figures. The
    // first run says what the thing does, never what it costs.
    // `pay` was missing, and "Any OpenAI-style service you already pay for"
    // was live on the no-key branch of a blank machine for the whole of this
    // release. A rule with a hole in it is not a rule; it is the hole.
    const banned = /\b(cheap\w*|discount\w*|wholesale|afford\w*|budget\w*|spend\w*|cost\w*|pric\w*|pay\w*|paid|token\w*|free|dollars?|cents?|per month|save money|value for money)\b/i;
    for (const { path, text } of everything) {
      const hit = banned.exec(text);
      expect.soft(hit ? `${path}: ${hit[0]} in "${text}"` : null).toBeNull();
    }
    for (const { path, text } of everything) {
      expect.soft(`${path}: ${text}`).not.toMatch(/[$£€]\s?\d/);
    }
  });

  it("never states a model count", () => {
    // "500+ apps" is the one figure this flow is allowed, and it is about
    // apps. A figure attached to models is the claim that was rejected.
    for (const { path, text } of everything) {
      for (const match of text.matchAll(/(\d[\d,]*)\s*\+/g)) {
        const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 12);
        expect.soft(`${path}: ${match[0]}${tail}`, `${path}: ${text}`).toMatch(/\d[\d,]*\s*\+\s*apps\b/);
      }
      expect.soft(`${path}: ${text}`).not.toMatch(/\d[\d,]*\s*\+?\s*(of the |latest |ai )*models/i);
    }
  });

  it("never frames the first run as school", () => {
    const banned = /\b(lesson|lessons|exercise|exercises|quiz|quizzes|assignment|assignments|homework|curriculum|tutorial)\b/i;
    for (const { path, text } of everything) {
      const hit = banned.exec(text);
      expect.soft(hit ? `${path}: ${hit[0]}` : null).toBeNull();
    }
  });

  it("never describes a capability as a limit", () => {
    const banned = /\b(i can never|i cannot|i can't|i am not allowed|i am unable|never able to)\b/i;
    for (const { path, text } of everything) {
      const hit = banned.exec(text);
      expect.soft(hit ? `${path}: ${hit[0]}` : null).toBeNull();
    }
  });

  // THE CEILING THAT WAS STATED AT THE TOP OF THE FILE AND ASSERTED NOWHERE.
  //
  // "Three sentences is the ceiling for a card body" has been in the rule
  // list the whole time with nothing behind it, which is how a rule that
  // lives only in a comment ends: everything else on the list got a test and
  // this one got a promise. It applies to every string, not just the fields
  // named `body`, because the renderer sets `second` and `third` and a row's
  // `why` as their own lines and a person reads them the same way. Four
  // sentences on a card is the paragraph this flow was re-cut to get rid of.
  function sentences(text: string): number {
    return text
      // A decimal point, a version and a time are not ends of sentences: an
      // end is punctuation with whitespace or nothing after it.
      .split(/[.!?]+(?=\s|$)/)
      .filter((part) => part.trim().length > 0).length;
  }

  it("keeps every line to the three sentence ceiling", () => {
    for (const { path, text } of everything) {
      const count = sentences(text);
      expect.soft(count > 3 ? `${path}: ${count} sentences in "${text}"` : null).toBeNull();
    }
  });

  // ONE NAMED EXEMPTION, AND ONLY ONE.
  //
  // The rule is that the flow does not hand somebody a signpost instead of
  // doing the thing. It is about the PATH THROUGH: every step the Chief asks
  // for, it also carries out, in the conversation, which is the whole point
  // of this release and what the modal it replaced got wrong.
  //
  // It is not a ban on the word. Somebody who has just declined the key on a
  // machine with nothing on it has deliberately stepped off that path, and
  // the two ways back, their own endpoint or a local model, genuinely live in
  // Settings and have no in-chat flow yet. Refusing to say so would not keep
  // them out of Settings; it would only stop them finding the thing that
  // rescues them. When that walk-through exists in the chat, this exemption
  // goes with it.
  const SETTINGS_EXEMPT = new Set(["FIRST_RUN_COPY.flux.no-key.secondBare"]);

  it("never sends the person to Settings on the way through", () => {
    for (const { path, text } of everything) {
      if (SETTINGS_EXEMPT.has(path)) continue;
      expect.soft(`${path}: ${text}`).not.toMatch(/\bsettings\b/i);
    }
  });

  it("keeps that exemption down to the branch it was written for", () => {
    // A growing list here is the rule quietly being repealed.
    expect(SETTINGS_EXEMPT.size).toBe(1);
    for (const path of SETTINGS_EXEMPT) {
      expect(everything.some((entry) => entry.path === path), `${path} no longer exists`).toBe(true);
    }
  });
});

describe("first run copy: the things the flow promises", () => {
  it("leads the Flux Router card with routing, then apps, then media", () => {
    const flux = FIRST_RUN_COPY.flux.key;
    expect(flux.body).toContain("all the latest AI models");
    expect(flux.body).toContain("smart routing");
    expect(flux.second).toContain("500+ apps");
    for (const named of ["Gmail", "Slack", "Notion", "GitHub"]) expect(flux.second).toContain(named);
    expect(flux.third).toMatch(/pictures.*transcription/);
    expect(flux.recommendation.toLowerCase()).toContain("recommended");
  });

  // THIS CARD MUST NOT PROMISE SPEECH, AND THE OLD ASSERTION DEMANDED IT.
  //
  // The line above used to read /pictures.*voice.*transcription/, so the test
  // was not guarding the copy, it was enforcing an untrue claim: Flux Router
  // exposes transcription at POST /v1/audio/transcriptions and NOTHING ELSE.
  // There is no /v1/audio/speech, no voice ids, no passthrough — stated at
  // the top of server/voice/flux-voice.ts, and src/lib/flux-invite.ts had
  // already refused to sell speech on this key for the same reason.
  //
  // Murage does speak, through ElevenLabs on the person's own credential or
  // the free OS voices. That is a different key and a different card. A
  // person who pays for Flux Router expecting their assistant to talk back
  // has been mis-sold, so the word is banned here rather than merely absent.
  //
  // IT WAS WRITTEN AGAINST FOUR FIELDS BY HAND, AND THE CLAIM IT EXISTS TO
  // STOP WAS SHIPPING ONE LINE BELOW THEM. `recommendationBonus` sold
  // "pictures and voice" on the same card, outside the whitelist, and the
  // audit found it rather than the test. So the walk is the whole file now:
  // every string a person can read during the first run, plus every sentence
  // the module assembles at render time. A hand-picked list of fields is a
  // list that goes stale the first time somebody adds a field.
  // AND NARROWED, ONCE, ON A RULING, TO THE ROW THAT ADMITS IT IS NOT READY.
  //
  // The owner: "voice mode is coming so you can have it as coming soon and
  // then we flick it over when it's available." Deleting the test to make room
  // for that row is the move this branch has regretted four times, so it is
  // not deleted and it is not loosened by hand. The exemption is DERIVED from
  // the data: a row is allowed to mention speech only when it declares, in the
  // copy itself, either that it is not live yet or that it is transcription.
  //
  // The property this now asserts is the stronger one: a row that mentions
  // speech is either marked coming-soon, or it is transcription. Writing "talk
  // to me" onto an unmarked row still fails. Writing it onto the transcription
  // row still fails, because a row that claims to be transcription may not
  // then promise an answer out loud.
  const SPEECH = /\b(voice|speaks?|spoken|read (?:it )?aloud|out loud|text to speech|talk to me|talk back|speak to you)\b/i;
  /** What a row claiming to be TRANSCRIPTION may never say. You talk, it
   *  types; the key has no synthesis endpoint of any kind. */
  const SYNTHESIS = /\b(voice|speaks?|spoken|read (?:it )?aloud|text to speech|talk to me|talk back|speak to you)\b/i;

  const features = FIRST_RUN_COPY.flux.key.features;
  const declared = new Set(
    features.flatMap((row, index) =>
      row.state === "coming-soon" || row.speech === "transcription"
        ? [`FIRST_RUN_COPY.flux.key.features[${index}].title`, `FIRST_RUN_COPY.flux.key.features[${index}].body`]
        : [],
    ),
  );

  it("never sells speech anywhere in the first run", () => {
    for (const { path, text } of everything) {
      if (declared.has(path)) continue;
      const hit = SPEECH.exec(text);
      expect.soft(
        hit ? `${path}: "${hit[0]}" in "${text}"` : null,
        "sells speech on a key that cannot synthesise it",
      ).toBeNull();
    }
  });

  it("lets a row mention speech only by declaring which kind it is", () => {
    // The exemption is not a list anybody edits. It is the `state` and
    // `speech` fields on the row, which the card RENDERS: a coming-soon row
    // carries the pill, so a row cannot buy itself the exemption without also
    // telling the person it is not ready.
    const speaking = features.filter((row) => SPEECH.test(`${row.title} ${row.body}`));
    expect(speaking.length).toBeGreaterThan(0);
    for (const row of speaking) {
      expect.soft(
        row.state === "coming-soon" || row.speech === "transcription",
        `"${row.title}" mentions speech without saying whether it is transcription or not built yet`,
      ).toBe(true);
    }
  });

  it("will not let a transcription row promise an answer out loud", () => {
    // Flux Router transcribes at POST /v1/audio/transcriptions and has no
    // synthesis endpoint at all. "You talk, it types" is the whole claim, and
    // a row that quietly grew into "talk to me" would be the shipped false
    // claim arriving through the exemption door.
    for (const row of features.filter((one) => one.speech === "transcription")) {
      expect.soft(`${row.title} ${row.body}`, `"${row.title}" promises speech back`).not.toMatch(SYNTHESIS);
      expect.soft(row.state, `"${row.title}" is transcription, which works today`).toBe("live");
    }
  });

  it("keeps every Flux claim to something that stops working without the key", () => {
    // Routines, teams and memory are NOT Flux features. Memory is built into
    // Murage, any enabled engine with `extractMemory` is eligible, and
    // routines contain zero Flux references. That mistake has been made five
    // times. The test is "does this stop working without the key".
    for (const row of features) {
      expect.soft(`${row.title} ${row.body}`, `"${row.title}" claims something Flux does not do`)
        .not.toMatch(/\b(routine|routines|memory|remembers?|team|teammate|crew)\b/i);
    }
  });

  // WHAT THE APPROVAL SYSTEM CAN KEY IS THE CEILING ON WHAT THE COPY MAY
  // PROMISE, AND THIS TEST USED TO REQUIRE A SENTENCE THAT BROKE IT.
  //
  // It demanded, verbatim: "You approve, I send. Once you trust me with a
  // kind of email, I can send those myself." The second half is not true and
  // cannot be made true. A remembered approval is keyed by the WHOLE tool
  // name (`approvalKey`, server/auto-approve.ts: anything that is not a
  // command tool keys on the tool itself), and every connected-app call,
  // read or write, Gmail or Slack, arrives through one wrapper tool
  // (server/composio.ts). There is no key for "this kind of email", so a
  // grant can never be narrowed to one. That the two are inseparable is
  // asserted against the real function in
  // server/first-run-email-trust.test.ts; here the subject is the words.
  //
  // AND THE TEST WAS THE REASON THE WORDS COULD NOT BE FIXED. Pinning a
  // sentence cannot check anything: the sentence is whatever it says it is.
  // All a pin can do is fail the moment somebody corrects it, which is the
  // fifth time prose pinning has held a claim in place in this file and the
  // second time it held a FALSE one. So this asserts the property. Any
  // sentence at all is allowed, as long as approval comes before sending and
  // no grant is promised that the approval system could not key.
  const SENDS_MAIL = /\b(e-?mails?|mail|replies|reply)\b/i;
  const SENDING = /\bsend(?:s|ing)?\b/i;
  /** A grant narrowed to a subset of what one key covers. There is exactly
   *  one key for all of it, so any of these is a promise nothing can keep. */
  const NARROWER_THAN_KEYABLE =
    /\b(?:a|an|any|each|one|this|that|these|those|some|certain|particular)\s+(?:kind|kinds|type|types|sort|sorts|category|categories)\s+of\b/i;

  it("puts sending email behind approval wherever the flow mentions it", () => {
    const sending = everything.filter(({ text }) => SENDS_MAIL.test(text) && SENDING.test(text));
    // If this ever drops to nothing, the flow stopped talking about email
    // rather than the rule being satisfied, and the rule would be vacuous.
    expect(sending.length, "no email-sending copy left to check").toBeGreaterThan(0);
    for (const { path, text } of sending) {
      expect.soft(`${path}: ${text}`, `${path} talks about sending mail without approval first`)
        .toMatch(/\byou approve\b/i);
    }
  });

  it("never promises a grant narrower than the approval system can key", () => {
    for (const { path, text } of everything) {
      const hit = NARROWER_THAN_KEYABLE.exec(text);
      expect.soft(
        hit ? `${path}: "${hit[0]}" in "${text}"` : null,
        "promises a per-category grant; approvals are keyed by the whole tool",
      ).toBeNull();
    }
  });

  it("offers a job rather than a team on the closing card", () => {
    const next = FIRST_RUN_COPY.routines.next;
    const hire = next.more.find((offer) => /teammate/i.test(offer.label));
    expect(hire?.label).toBe("Hire your first teammate");
    for (const offer of [...next.work, ...next.more]) {
      expect.soft(offer.label).not.toMatch(/build a team/i);
      expect.soft(offer.say).not.toMatch(/build a team/i);
    }
  });

  // Backups are a smart default and never a step: nothing in the six-step
  // checklist is about them, and everything the flow says about them lives in
  // the one `backups` group under the closing card. The group has more than
  // one sentence because it tells the truth about two different machines, one
  // where backups are already running and one where they are not, and about
  // what happened after the press. What it must never do is become a step, or
  // turn up in the middle of the flow.
  it("keeps backups out of the steps, and in one place", () => {
    const mentions = readable.filter((entry) => /backup/i.test(entry.text));
    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) {
      expect.soft(mention.path, `${mention.path} talks about backups outside the backups group`)
        .toMatch(/^FIRST_RUN_COPY\.backups\./);
    }
  });

  // WHAT THE BACKUP TAKES IS THE CEILING ON WHAT THE CARD MAY OFFER.
  //
  // The offer read "a private copy of everything on this computer, taken
  // fresh every day". The capture is Murage's own installation data and
  // nothing else: server/installation-fidelity-snapshot.ts walks the data
  // directory, keeps a named set of application roots and EXCLUDES the rest
  // by name, credentials and native custody and models and logs and browser
  // profiles among them. Documents, applications and working folders are not
  // in it. The card was parked and unreachable when the audit found this,
  // which is not a defence: the words were in the tree, the copy test walked
  // them, and an unreachable card is one render away from being reachable.
  //
  // The property is what the offer may CLAIM, not which sentence it uses: no
  // string in the flow may offer a copy of the machine, and the offer has to
  // name what it really takes rather than going vague to slip past the ban.
  it("never offers a backup wider than the installation it takes", () => {
    const WHOLE_MACHINE =
      /\b(?:everything|every file|all (?:your |the )?(?:files|data)|anything) (?:on|from) (?:this|your) (?:computer|machine|laptop|mac|pc|drive)\b|\byour (?:whole|entire) (?:computer|machine|laptop|drive)\b|\byour documents\b|\bhard drive\b/i;
    const backups = readable.filter((entry) => entry.path.startsWith("FIRST_RUN_COPY.backups."));
    expect(backups.length, "the backups group vanished").toBeGreaterThan(0);
    for (const { path, text } of backups) {
      const hit = WHOLE_MACHINE.exec(text);
      expect.soft(
        hit ? `${path}: "${hit[0]}" in "${text}"` : null,
        "offers a copy of the computer; the capture is the Murage installation",
      ).toBeNull();
    }
    // And it says what it does take, so "a private copy, taken fresh every
    // day" cannot pass the ban by naming nothing at all.
    const offer = FIRST_RUN_COPY.backups.offer;
    for (const named of [/\bbots\b/i, /\broutines\b/i]) {
      expect.soft(offer, "the offer does not name what is in the backup").toMatch(named);
    }
  });

  it("never claims found engines on a bare machine", () => {
    expect(FIRST_RUN_COPY.agents.bare.body).not.toMatch(/found|connected them/i);
    expect(foundAgentsLine(["Claude Code", "Codex"])).toContain("Claude Code and Codex");
  });
});

// THE KEY CARD IS READ BY TWO PEOPLE IN DIFFERENT SITUATIONS.
//
// Murage ships the engine, not the brain. On a clean machine this key is what
// gives the engine something to think with, and calling it merely
// "recommended" is an understatement they discover one card later. On a
// machine that already had Claude Code or Codex, they are working already and
// telling them they NEED it would be false, and false in the way that reads
// as a sales pitch.
describe("what the key card claims, to whom", () => {
  const key = FIRST_RUN_COPY.flux.key;

  it("does not tell somebody who is already working that they need it", () => {
    expect(fluxRecommendation({ agents: [{ id: "claude" }] })).toBe(key.recommendationBonus);
    expect(key.recommendationBonus).toMatch(/optional/i);
    expect(key.recommendationBonus).not.toMatch(/\bneed\b|\brequired\b/i);
  });

  it("does not undersell it to somebody who has nothing", () => {
    expect(fluxRecommendation({ agents: [] })).toBe(key.recommendationBare);
    expect(key.recommendationBare).not.toMatch(/optional/i);
  });

  it("takes the milder claim when it cannot tell", () => {
    // The claim that is never wrong is the one to make with no answer yet.
    expect(fluxRecommendation(null)).toBe(key.recommendation);
    expect(fluxRecommendation({})).toBe(key.recommendation);
  });

  it("leads on routing in every version, and never counts models", () => {
    for (const line of [key.body, key.recommendation, key.recommendationBare, key.recommendationBonus]) {
      expect.soft(line, line).not.toMatch(/\d+\s*\+?\s*models/i);
      expect.soft(line, line).not.toMatch(/composio/i);
    }
    expect(key.body).toMatch(/all the latest/i);
    expect(key.body).toMatch(/routing/i);
  });
});

// THE NO-KEY BRANCH IS NOT A DEAD END, AND MUST NOT READ LIKE ONE.
//
// The engine takes any OpenAI-style endpoint with a key, which is most of the
// industry, plus anything running on the machine itself. So "not now" always
// has a way on. What it must never do is tell somebody with nothing that they
// are carrying on with what is on their machine, because there is nothing on
// their machine and they would sit there believing they had chosen it.
describe("saying not now to the key", () => {
  const noKey = FIRST_RUN_COPY.flux["no-key"];

  it("does not claim there is something to carry on with when there is not", () => {
    expect(noKey.body).toMatch(/carry on/i);
    expect(noKey.bodyBare).not.toMatch(/carry on/i);
  });

  it("names a real way on, and does not promise a flow that does not exist", () => {
    expect(noKey.secondBare).toMatch(/openai/i);
    // No "I will walk you through it": nothing implements that walk yet, and
    // the whole point of this release is not promising what has not happened.
    expect(noKey.secondBare).not.toMatch(/walk you through|I will set (it|that) up/i);
  });
});

describe("first run copy: the sentence builders", () => {
  it("joins engine names the way a person would say them", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["  "])).toBe("");
    expect(joinNames(["Codex"])).toBe("Codex");
    expect(joinNames(["Claude Code", "Codex"])).toBe("Claude Code and Codex");
    expect(joinNames(["Claude Code", "Codex", "Fuigo"])).toBe("Claude Code, Codex and Fuigo");
  });

  it("says a time out loud rather than in 24 hour clock", () => {
    expect(clockLabel("07:00")).toBe("7:00 am");
    expect(clockLabel("00:30")).toBe("12:30 am");
    expect(clockLabel("12:00")).toBe("12:00 pm");
    expect(clockLabel("18:30")).toBe("6:30 pm");
    // Nonsense in, the same nonsense out: never a wrong time said with
    // confidence.
    expect(clockLabel("nope")).toBe("nope");
    expect(clockLabel("42:00")).toBe("42:00");
  });

  it("repeats the chosen time back on the button", () => {
    expect(briefButtonLabel("07:00")).toBe("Set my brief for 7:00 am");
  });

  it("greets by name when there is one, and is not a receipt", () => {
    expect(greetingLine("Sean")).toContain("Sean");
    expect(greetingLine("  Sean  ")).toContain("Sean");
    expect(greetingLine("")).not.toContain("undefined");
    // "Thank you. I have got that." was correct and read like a form
    // confirming a submission. This is the first thing a chief of staff ever
    // says to the person they work for.
    for (const line of [greetingLine("Sean"), greetingLine("")]) {
      expect.soft(line, line).not.toMatch(/thank you|got that|saved|recorded/i);
    }
  });
});
