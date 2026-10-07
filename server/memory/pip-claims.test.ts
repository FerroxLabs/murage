// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 grammar tests (design §4 I-3, I-3b; amendment A.4, A.9, N6, N16):
// the fixture list, the round trip of every template, and the comparison rules.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  claimsCompatible, claimsContradict, claimsRelated, foldContractions, gerundBase, ownerSentences, parseAuthoredStatement, sentenceSpans,
  parseOwnerSentence, parseOwnerText, retractTargetKeys, type OwnerSentenceResult, type ParsedClaim, type RetractEvent,
} from "./pip-claims.ts";
import { BASE_VERBS, CONTRACTIONS, LEXICON } from "./pip-vocabulary.ts";

const ok = (sentence: string, options?: { botName?: string }) => {
  const result = parseOwnerSentence(sentence, options);
  if (!result.ok || result.production === "RETRACT") throw new Error(`expected a claim for "${sentence}", got ${JSON.stringify(result)}`);
  return result;
};
const refused = (sentence: string) => { const result = parseOwnerSentence(sentence); expect(result.ok, sentence).toBe(false); return result as Extract<OwnerSentenceResult, { ok: false }>; };
const authored = (statement: string) => { const claim = parseAuthoredStatement(statement); if (!claim) throw new Error(`expected an authored claim for "${statement}"`); return claim; };
const withoutAct = (claim: ParsedClaim) => ({ ...claim, act: "" });

describe("PIP grammar: normalisation", () => {
  it("folds every contraction in the published table", () => {
    for (const [short, long] of CONTRACTIONS) expect(foldContractions(`xx ${short} yy`)).toBe(`xx ${long} yy`);
    expect(foldContractions("You’d  BE brief")).toBe("you would be brief");
  });
  it("derives gerunds from the base-verb list", () => {
    expect(gerundBase("apologizing")).toBe("apologize");
    expect(gerundBase("stopping")).toBe("stop");
    expect(gerundBase("being")).toBe("be");
    expect(gerundBase("running")).toBeUndefined();
    expect(BASE_VERBS).toContain("apologize");
    expect(BASE_VERBS).not.toContain("apologizing");
  });
});

describe("PIP grammar: the design fixtures", () => {
  it("handles each production with its template", () => {
    expect(ok("You are brief.").statement).toBe("I am brief");
    expect(ok("You are not brief.").statement).toBe("I am not brief");
    expect(ok("You always apologize.").statement).toBe("I always apologize");
    expect(ok("You never apologize.")).toMatchObject({ statement: "I never apologize", claim: { polarity: "negative", frequency: "never", aspect: "habit" } });
    expect(ok("You usually answer briefly").statement).toBe("I usually answer briefly");
    expect(ok("You often add caveats").statement).toBe("I often add caveats");
    expect(ok("Do not apologize").statement).toBe("I will not apologize");
    expect(ok("Never apologize").statement).toBe("I will never apologize");
    expect(ok("Stop apologizing").statement).toBe("I will stop apologizing");
    expect(ok("Be brief").statement).toBe("I will be brief");
    expect(ok("Always be brief").statement).toBe("I will always be brief");
    expect(ok("Please make sure to confirm the date").statement).toBe("I must confirm the date");
    expect(ok("From now on, confirm the date").statement).toBe("From now on, I will confirm the date");
    expect(ok("Next time, do not guess").statement).toBe("Next time, I will not guess");
    expect(ok("You need to ask first").statement).toBe("I should ask first");
    expect(ok("We agreed to review on Fridays").statement).toBe("I will review on Fridays");
  });

  it("keeps the owner's capitals in the statement and lower-cases only the key", () => {
    const named = ok("From now on, email Sarah first");
    expect(named.statement).toBe("From now on, I will email Sarah first");
    expect(named.claim.predicateKey).toBe("email sarah first");
    expect(ok("YOU ARE Brief").statement).toBe("I am Brief");
  });

  it("covers the listed attack and mechanism sentences", () => {
    expect(refused("You are reliable?").reason).toBe("question");
    expect(refused("You seem reliable").reason).toBe("uncertain");
    expect(refused("You are reliable if the build is green").reason).toBe("uncertain");
    expect(refused("You are never reliable").reason).toBe("frequency-in-pred");
    expect(refused("You never not apologize").reason).toBe("double-negation");
    expect(refused("You should not never apologize").reason).toBe("negation-inside");
    expect(refused("forget that").reason).toBe("no-match");
    expect(refused("let's be brief").reason).toBe("no-match");
    expect(refused("agreed").reason).toBe("no-match");
    expect(refused("we agreed that the plan is fine").reason).toBe("no-match");
    expect(refused('The assistant wrote "you are reliable" earlier').ok).toBe(false);
    expect(refused("Maybe be brief").reason).toBe("uncertain");
    expect(refused("Be brief, but add detail").reason).toBe("uncertain");
    expect(refused("Be brief or be detailed").reason).toBe("uncertain");
    expect(refused("Be brief when you reply").reason).toBe("uncertain");
    expect(refused("He is always late").reason).toBe("no-match");
  });

  it("answers the quoted-assistant-text and question rules at message level", () => {
    const results = parseOwnerText("> you are reliable\nPlease do not apologize. Are you sure?\nStop apologizing!");
    expect(results.map(r => r.sentence)).toEqual(["Please do not apologize.", "Are you sure?", "Stop apologizing!"]);
    expect(results.map(r => r.result.ok)).toEqual([true, false, true]);
  });

  it("maps stop to a bare statement, should to should, and try to to attempt", () => {
    expect(ok("You should not apologize").statement).toBe("I should not apologize");
    const attempt = ok("Try to answer briefly");
    expect(attempt.statement).toBe("I will try to answer briefly");
    expect(attempt.claim.modality).toBe("attempt");
    expect(ok("Try to not apologize").statement).toBe("I will try not to apologize");
  });

  it("keeps the N16 verb rule: apologize is admitted, apologizing and apologies are refused after no more", () => {
    expect(ok("Do not apologize").statement).toBe("I will not apologize");
    expect(refused("No more apologizing").reason).toBe("bad-verb");
    expect(refused("No more apologies").reason).toBe("bad-verb");
    expect(ok("No more guessing about dates".replace("guessing", "guess")).statement).toBe("I will not guess about dates");
    expect(refused("Do not apologizing").reason).toBe("bad-verb");
    expect(refused("Stop apologize").reason).toBe("bad-verb");
  });

  it("parses the contraction fixture and the A.9 polarity forms", () => {
    const agreed = ok("we agreed that you'd be brief");
    expect(agreed).toMatchObject({ production: "AGREE", statement: "I will be brief", claim: { property: "answer-detail", value: "brief", polarity: "positive" } });
    const notBrief = ok("we agreed that you'd not be brief");
    expect(notBrief).toMatchObject({ statement: "I will not be brief", claim: { polarity: "negative", property: "answer-detail", value: "brief" } });
    expect(ok("we agreed that you should answer first").statement).toBe("I should answer first");
    expect(ok("we agreed to not hedge").statement).toBe("I will not hedge");
    expect(ok("you tend to not apologize")).toMatchObject({ production: "OBS-TEND", statement: "I tend not to apologize", claim: { polarity: "negative" } });
    expect(ok("you tend not to apologize").statement).toBe("I tend not to apologize");
    expect(ok("you tend to apologize").statement).toBe("I tend to apologize");
    expect(ok("you keep apologizing").statement).toBe("I keep apologizing");
    expect(refused("you keep not apologizing").ok).toBe(false);
  });

  it("separates a negative state from a retraction", () => {
    expect(ok("you're not reliable")).toMatchObject({ production: "OBS-STATE", claim: { polarity: "negative", predicateKey: "reliable" } });
    const retract = parseOwnerSentence("you're not reliable any more");
    expect(retract).toMatchObject({ ok: true, production: "RETRACT", retract: { predicateKey: "reliable" } });
    for (const sentence of ["you do not need to apologize anymore", "you can stop apologizing", "we are not doing standups", "never mind about the report", "forget about the report"])
      expect(parseOwnerSentence(sentence), sentence).toMatchObject({ ok: true, production: "RETRACT" });
    const stop = parseOwnerSentence("you can stop apologizing") as { retract: RetractEvent };
    expect(retractTargetKeys(stop.retract)).toEqual(["apologizing", "apologize"]);
  });

  it("drops a vocative and a bot name", () => {
    expect(ok("Pip, please do not apologize", { botName: "Pip" }).statement).toBe("I will not apologize");
    expect(ok("okay so be brief").statement).toBe("I will be brief");
    expect(refused("Pip, please do not apologize").ok).toBe(false);
  });

  it("splits sentences on punctuation and drops pasted segments", () => {
    expect(ownerSentences("Be brief. Do not guess!\n> Be loud\nThanks")).toEqual(["Be brief.", "Do not guess!", "Thanks"]);
  });
});

describe("PIP grammar: I-3b and the round trip", () => {
  const OWNER_SENTENCES = [
    "You are brief", "You are not brief", "You are not reliable", "You always apologize", "You usually answer briefly", "You often add caveats", "You never apologize",
    "You tend to apologize", "You tend not to apologize", "You tend to not hedge", "You keep apologizing",
    "Do not apologize", "Never apologize", "Stop apologizing", "No more guessing".replace("guessing", "guess"), "Be brief", "Always be brief", "Be brief with invoices",
    "Do be careful", "Always confirm the date", "From now on confirm the date", "Going forward do not guess", "Next time ask first", "Next time do not guess",
    "Try to answer briefly", "Try to not apologize", "You should answer first", "You should not hedge", "You need to ask first", "You must confirm", "You must not guess",
    "I want you to answer first", "I would like you to be brief", "Make sure to confirm", "Make sure you confirm", "We agreed to review on Fridays", "We agreed to not hedge",
    "We agreed that you will confirm", "We agreed that you would not hedge", "We agreed that you should ask first", "We agreed that you should not hedge",
    "Do not be rude", "Never be rude", "Stop being rude", "You should be concise", "Please be formal with clients",
  ];
  it("parses every template instance under I-3b to the same claim, except act", () => {
    for (const sentence of OWNER_SENTENCES) {
      const produced = ok(sentence);
      const reparsed = authored(produced.statement);
      expect(withoutAct(reparsed), `${sentence} -> ${produced.statement}`).toEqual(withoutAct(produced.claim));
      expect(reparsed.act).toBe("AUTHORED");
    }
  });
  it("refuses anything outside the canonical forms", () => {
    for (const text of ["Water the plants on Tuesday.", "I will", "I am", "I will not not apologize", "I will apologizing", "I always never apologize", "I keep apologize", "From now on, I always apologize", "Next time, I should apologize",
      "You will apologize", "I would apologize", "I am always late", "I will be", "I will probably apologize"])
      expect(parseAuthoredStatement(text), text).toBeNull();
  });
  it("round-trips the habit forms of I-3b", () => {
    for (const form of ["I always apologize", "I usually apologize", "I often apologize", "I never apologize", "I tend to apologize", "I tend not to apologize", "I keep apologizing"])
      expect(parseAuthoredStatement(form), form).toMatchObject({ kind: "self-trait", aspect: "habit", subject: "bot" });
    expect(authored("I never apologize")).toMatchObject({ polarity: "negative", frequency: "never" });
  });
  it("derives property, value and scope from the lexicon and drops the light verb", () => {
    expect(authored("I will be brief with invoices")).toMatchObject({ predicateKey: "brief with invoices", property: "answer-detail", value: "brief", predicateScope: "with invoices", temporalBucket: "standing", aspect: "state" });
    expect(authored("I am brief")).toMatchObject({ predicateScope: "", temporalBucket: "present", kind: "self-trait" });
    expect(authored("Next time, I will be brief").temporalBucket).toBe("next-time");
    expect(authored("I will answer briefly")).toMatchObject({ property: "answer-detail", value: "brief", predicateScope: "answer" });
    expect(authored("I will apologize")).toMatchObject({ property: null, value: null, predicateScope: "apologize" });
  });
  it("keeps every lexicon token on a single property and every verb unique", () => {
    expect(new Set(BASE_VERBS).size).toBe(BASE_VERBS.length);
    for (const [, [property, value]] of Object.entries(LEXICON)) { expect(property).toMatch(/^[a-z-]+$/); expect(value).toMatch(/^[a-z-]+$/); }
  });
});

describe("PIP grammar: claim comparison (A.4)", () => {
  const owner = (sentence: string) => ok(sentence).claim;
  it("treats a different scope as related, not counted", () => {
    const a = authored("I should be brief with incident reports");
    const b = owner("You should be brief with invoices");
    expect(claimsCompatible(a, b)).toBe(false);
    expect(claimsContradict(a, b)).toBe(false);
    expect(claimsRelated(a, b)).toBe(true);
    const bare = owner("Be brief"), scoped = owner("Be brief with invoices");
    expect(claimsCompatible(bare, scoped)).toBe(false);
    expect(claimsRelated(bare, scoped)).toBe(true);
  });
  it("finds a contradiction only on the same scope", () => {
    const brief = owner("Be brief with invoices");
    expect(claimsContradict(brief, owner("Be detailed with invoices"))).toBe(true);
    expect(claimsContradict(owner("Be detailed with invoices"), brief)).toBe(true);
    const elsewhere = owner("Be detailed with incident reports");
    expect(claimsContradict(brief, elsewhere)).toBe(false);
    expect(claimsRelated(brief, elsewhere)).toBe(true);
    expect(claimsCompatible(brief, elsewhere)).toBe(false);
  });
  it("lets an equivalent phrasing reinforce", () => {
    expect(claimsCompatible(owner("Be brief"), authored("I will be brief"))).toBe(true);
    expect(claimsCompatible(owner("You should be concise"), authored("I should be brief"))).toBe(true);
    expect(claimsCompatible(owner("Make sure to be brief"), owner("Be brief"))).toBe(false);
    expect(claimsCompatible(owner("Do not apologize"), authored("I will not apologize"))).toBe(true);
    expect(claimsCompatible(owner("Next time be brief"), owner("Be brief"))).toBe(false);
  });
  it("shares a key across a trait and a flip: you are not reliable against I am reliable", () => {
    const reliable = authored("I am reliable"), notReliable = owner("You are not reliable");
    expect(reliable.predicateKey).toBe(notReliable.predicateKey);
    expect(claimsContradict(reliable, notReliable)).toBe(true);
    expect(claimsCompatible(reliable, notReliable)).toBe(false);
  });
  it("keeps frequency qualifiers apart", () => {
    const often = owner("you often apologize"), always = authored("I always apologize");
    expect(claimsCompatible(often, always)).toBe(false);
    expect(claimsContradict(often, always)).toBe(false);
    expect(claimsRelated(often, always)).toBe(true);
  });
  it("sees no tension between I am brief and I am not detailed", () => {
    const a = authored("I am brief"), b = authored("I am not detailed");
    expect(claimsContradict(a, b)).toBe(false);
    expect(claimsContradict(b, a)).toBe(false);
    expect(claimsCompatible(a, b)).toBe(false);
  });
  it("never counts a commitment as a trait", () => {
    expect(claimsCompatible(owner("You should be reliable"), authored("I am reliable"))).toBe(false);
    expect(claimsContradict(owner("You should be reliable"), owner("You are not reliable"))).toBe(false);
  });
  it("resolves a retraction to the target and to its base form", () => {
    const target = owner("Do not apologize");
    const event = (parseOwnerSentence("you can stop apologizing") as { retract: RetractEvent }).retract;
    expect(claimsContradict(target, event)).toBe(true);
    expect(claimsContradict(owner("Do not guess"), event)).toBe(false);
    const state = (parseOwnerSentence("you're not reliable any more") as { retract: RetractEvent }).retract;
    expect(claimsContradict(authored("I am reliable"), state)).toBe(true);
  });
});

describe("audit finding 8: quoted multi-sentence text is never owner evidence", () => {
  it("keeps a quotation whole across its sentence delimiters and refuses it", () => {
    const text = '"You are reliable. You always apologize."';
    expect(ownerSentences(text)).toEqual([text]);
    const parsed = parseOwnerText(text);
    expect(parsed).toHaveLength(1);
    expect(parsed.every(p => !p.result.ok)).toBe(true);
    expect((parsed[0].result as { reason: string }).reason).toBe("uncertain");
  });
  it("covers curly quotes, a quotation inside a longer message, and one that spans a newline", () => {
    for (const text of ["\u201CYou are reliable. You always apologize.\u201D", 'She said "You are reliable. You always apologize." to me', '"You are reliable.\nYou always apologize."']) {
      expect(parseOwnerText(text).filter(p => p.result.ok), text).toEqual([]);
    }
    // text outside the quotation still parses on its own
    const mixed = parseOwnerText('Be brief. "You are reliable. You always apologize."');
    expect(mixed.filter(p => p.result.ok).map(p => p.sentence)).toEqual(["Be brief."]);
  });
  it("an unterminated or lone quote mark refuses its sentence and everything it swallows", () => {
    expect(parseOwnerText('You are "reliable. You always apologize.').filter(p => p.result.ok)).toEqual([]);
    expect(refused('You are "reliable').reason).toBe("uncertain");
  });
  it("splits ordinary text exactly as before, and the span index points at the piece", () => {
    expect(ownerSentences("Please be brief. Do not apologize!\nYou are kind?")).toEqual(["Please be brief.", "Do not apologize!", "You are kind?"]);
    const spans = sentenceSpans("Ab. Cd");
    expect(spans).toEqual([{ index: 0, raw: "Ab." }, { index: 3, raw: " Cd" }]);
  });
});

describe("audit finding 9: one negation contract for state claims", () => {
  it("I am no longer reliable is a negative state claim, never a positive one", () => {
    const claim = authored("I am no longer reliable");
    expect(claim).toMatchObject({ kind: "self-trait", polarity: "negative", predicateKey: "reliable" });
    expect(claimsContradict(claim, authored("I am reliable"))).toBe(true);
    expect(authored("I am not reliable")).toMatchObject({ polarity: "negative", predicateKey: "reliable" });
  });
  it("a doubled negation is refused rather than reversed", () => {
    expect(parseAuthoredStatement("I am not no longer reliable")).toBeNull();
    expect(parseAuthoredStatement("I am never reliable")).toBeNull();
    expect(refused("You are not no longer reliable").reason).toBe("double-negation");
  });
  it("the owner path applies the same rule: You are no longer reliable is a negative OBS-STATE", () => {
    const result = ok("You are no longer reliable");
    expect(result.production).toBe("OBS-STATE");
    expect(result.statement).toBe("I am not reliable");
    expect(result.claim).toMatchObject({ polarity: "negative", predicateKey: "reliable" });
    // and it agrees with the authored statement the owner would see
    expect(claimsCompatible(result.claim!, authored(result.statement!))).toBe(true);
  });
});

describe("PIP vocabulary file", () => {
  const doc = readFileSync(new URL("../../lanes/pip/CLAIM-VOCABULARY.md", import.meta.url), "utf8");
  it("publishes every contraction, lexical form and base verb", () => {
    for (const [short] of CONTRACTIONS) expect(doc).toContain(`\`${short}\``);
    for (const token of Object.keys(LEXICON)) expect(doc).toContain(`\`${token}\``);
    for (const verb of BASE_VERBS) expect(doc).toContain(`\`${verb}\``);
  });
});
