import { afterEach, describe, expect, it, vi } from "vitest";
import * as labels from "../../shared/md-secret-label.mjs";
import { redactSecretsForSink } from "../redact.ts";
import { CallSpeechSource } from "./call-speech-source.ts";
import * as speechSource from "./speech-source.ts";
import * as speechText from "./speech-text.ts";
import * as optionB from "./speech-source-option-b.ts";
import * as redaction from "../redact.ts";
import { compileSpeechChunks, compileSpeechSource, MAX_SOURCE_BYTES, REST_ON_SCREEN } from "./speech-source.ts";

afterEach(() => vi.restoreAllMocks());

describe("D24 Option B.2 raw whole-source gate", () => {
  it.each([false, true])("red-at-aa73cb96d: final code-span reparse, pronounce=%s", pronounce => {
    for (const source of ["Hello. `%4**1**`", "Hello. `&co**py**;`"])
      expect(compileSpeechSource(source, { pronounce })).toBe(REST_ON_SCREEN);
  });

  it("red-at-aa73cb96d: final gate errors release only the constant", () => {
    const predicate = optionB.optionBCut;
    let calls = 0;
    vi.spyOn(optionB, "optionBCut").mockImplementation(text => {
      if (++calls === 4) throw new Error("final release gate");
      return predicate(text);
    });
    expect(compileSpeechSource("Hello.")).toBe(REST_ON_SCREEN);
    expect(calls).toBe(4);
  });

  it("red-at-aa73cb96d: caller formatting joins a trigger before release", () => {
    expect(compileSpeechSource("Hello.", { releaseTransform: text => `${text} %41` })).toBe(REST_ON_SCREEN);
    expect(compileSpeechSource("Hello.", { prefix: "`&co**py**;`" })).toBe(REST_ON_SCREEN);
  });

  it("red-at-aa73cb96d: utterance preparation errors release only the constant", () => {
    expect(compileSpeechChunks("Hello.", () => { throw new Error("splitter"); })).toEqual([REST_ON_SCREEN]);
  });

  // Red at aa73cb96d only because compileSpeechChunks is new there; it pins that the new API keeps plain utterances' characters.
  it("red-at-aa73cb96d (new API): compileSpeechChunks keeps plain utterances' characters", () => {
    const text = "A readable first sentence. A readable second sentence.";
    expect(compileSpeechChunks(text, speechText.plainSpeechUtterances, { pronounce: false }))
      .toEqual(speechText.plainSpeechUtterances(text));
  });

  // Baseline control on the parent API only (green at aa73cb96d and at the fix): compile, then split.
  it("control (parent API): plain utterances of a compiled benign source keep their characters", () => {
    const text = "A readable first sentence. A readable second sentence.";
    expect(speechText.plainSpeechUtterances(compileSpeechSource(text, { pronounce: false })))
      .toEqual(speechText.plainSpeechUtterances(text));
  });

  // Astra D24B3 Medium: chunks were joined with "" before the final gate, so benign text either side of a
  // chunk boundary ("%4" | "1zzz") formed "%41" and the whole utterance was cut. Red at 73c06bcc3.
  it("red-at-73c06bcc3: benign text split at a chunk boundary is not joined into a trigger", () => {
    const source = "word ".repeat(63) + "%4 " + "1" + "z".repeat(30) + ".";
    const parent = speechText.plainSpeechUtterances(compileSpeechSource(source, { pronounce: false }));
    expect(parent.length, "the splitter cuts at the space after %4").toBeGreaterThan(1);
    expect(parent.some(chunk => chunk.endsWith("%4")), "the first chunk ends at %4").toBe(true);
    expect(parent).not.toContain(REST_ON_SCREEN);
    const chunks = compileSpeechChunks(source, speechText.plainSpeechUtterances, { pronounce: false });
    expect(chunks).not.toEqual([REST_ON_SCREEN]);
    expect(chunks.map(chunk => chunk.trim())).toEqual(parent);
  });

  it("control: chunk boundaries cannot hide real or splitter-created triggers", () => {
    expect(compileSpeechChunks("Value %41 now.", text => [text.slice(0, 8), text.slice(8)], { pronounce: false }))
      .toEqual([REST_ON_SCREEN]);
    expect(compileSpeechChunks("Hello.", () => ["Value %4", "1 now."], { pronounce: false }))
      .toEqual([REST_ON_SCREEN]);
    expect(compileSpeechChunks("Hello.", () => ["password", ": fixture"], { pronounce: false }))
      .toEqual([REST_ON_SCREEN]);
  });

  // These transforms cannot create a NEW trigger in these controls: URL consumes
  // its entire non-whitespace run (including punctuation); whitespace keeps a
  // separator (and Option B already collapses it); heading/list removal retains
  // the preceding line break. None joins entity/percent characters across it.
  it.each([
    ["URL -> link", "See https://example.test/a%20b now.", "See link now."],
    ["whitespace collapse", "Hello.\nGood   day.", "Hello. Good day."],
    ["heading strip", "Hello.\n# Good day.", "Hello. Good day."],
    ["list strip", "Hello.\n- Good day.", "Hello. Good day."],
    // Marker substitution supplies only letters; marker repair drops the tail
    // when adjacent punctuation could otherwise complete an entity/label.
    ["marker replacement", "Hello. «redacted» now.", "Hello. redacted now."],
    ["marker repair", "Hello. «broken» tail", `Hello. redacted ${REST_ON_SCREEN}`],
    // Span/label cuts and their redacted suffix discard the tail; no removed
    // tail is joined back onto the prefix to complete a trigger.
    ["span spoken join", "Hello. [guide](destination) now.", "Hello. guide now."],
    ["unsafe span cut and redacted suffix", "Hello. < there", `Hello. redacted ${REST_ON_SCREEN}`],
  ])("control: %s", (_transform, source, expected) => {
    expect(compileSpeechSource(source, { pronounce: false })).toBe(expected);
  });

  it("control: label cuts and sink redaction remain behind the final gate", () => {
    // A label would already trigger the retained early gate; final label cuts
    // cannot create a percent/entity sequence by deleting a trailing value.
    expect(compileSpeechSource("Hello. password: value")).toBe(REST_ON_SCREEN);
    expect(compileSpeechSource("Hello. «redacted 12 chars» now.")).toBe("Hello. redacted now.");
  });

  it("red-at-aa73cb96d: final sink redaction output is checked", () => {
    const redact = redaction.redactSecretsForSink;
    let calls = 0;
    vi.spyOn(redaction, "redactSecretsForSink").mockImplementation(text => ++calls === 2 ? "Hello. %41" : redact(text));
    expect(compileSpeechSource("Hello.")).toBe(REST_ON_SCREEN);
  });

  // Inject at the sink boundary to reach the FINAL pass's transforms rather
  // than letting the first lexer consume their syntax. These benign controls
  // cannot form a trigger: replacement words contain no trigger punctuation;
  // cuts discard tails, and whitespace/line-prefix removal keeps a separator.
  it.each([
    ["final label cut", "Hello. password: value", "Hello. password redacted", true],
    ["final marker repair", "Hello. «broken» tail", "Hello. redacted redacted", true],
    ["final marker replacement", "Hello. «redacted» now.", "Hello. redacted now.", false],
    ["final URL replacement", "Hello. https://example.test/a%20b now.", "Hello. link now.", false],
    ["final heading/list strip", "Hello.\n# Good day.\n- Fine.", "Hello. Good day. Fine.", false],
    ["final whitespace collapse", "Hello.\nGood   day.", "Hello. Good day.", false],
  ] as const)("control: %s produces benign release text", (_name, injected, checked, cut) => {
    const redact = redaction.redactSecretsForSink;
    let calls = 0;
    vi.spyOn(redaction, "redactSecretsForSink").mockImplementation(text => ++calls === 2 ? injected : redact(text));
    expect(compileSpeechSource("Hello.", { pronounce: false })).toBe(checked + (cut ? ` ${REST_ON_SCREEN}` : ""));
  });

  it.each(["#", "-"])("control: %s prefix removal exposes a label and whole-cuts", mark => {
    expect(compileSpeechSource(`Hello. password\n${mark} : value`)).toBe(REST_ON_SCREEN);
  });

  it("control: sentence cap keeps exactly its constant suffix", () => {
    // Truncation at a sentence end drops a tail, never joins it to the prefix;
    // the appended constant has no tag, percent, entity or secret label trigger.
    expect(optionB.optionBCut(REST_ON_SCREEN)).toBe(false);
    expect(compileSpeechSource("Hello. " + "Good day. ".repeat(20), { maxUnits: 30, pronounce: false }))
      .toBe(`Hello. ${REST_ON_SCREEN}`);
  });

  // red-at-6ba44ff37: digit-leading entity-shaped text escaped the raw gate.
  it("whole-cuts a digit-leading entity", () => {
    expect(compileSpeechSource("Hello. &1;")).toBe(REST_ON_SCREEN);
  });

  // red-at-6ba44ff37: arbitrary closers and code received a destination exemption.
  it.each([
    ["unmatched destination", "Hello. ](%41) now."],
    ["code-span destination", "Hello. `](%41)` now."],
    ["code-span link", "Hello. `[guide](%41)` now."],
  ])("whole-cuts %s", (_name, source) => {
    expect(compileSpeechSource(source)).toBe(REST_ON_SCREEN);
  });

  // control: the speech grammar recognizes these destinations, including nesting.
  it.each([
    ["Hello. [guide](%41) now.", "Hello. guide now."],
    ["Hello. ![diagram](%41) now.", "Hello. image omitted now."],
    ["Hello. [outer [inner](%41)](A_(b)%20c) now.", "Hello. outer inner now."],
  ])("keeps recognized markdown destinations: %s", (source, expected) => {
    expect(compileSpeechSource(source)).toBe(expected);
  });

  // red-at-6ba44ff37: removing decoration creates triggers after the raw check.
  it.each([
    ["joined entity", "Hello. &co**py**;"],
    ["joined percent run", "Hello. %4**1**"],
  ])("whole-cuts %s before final protection", (_name, source) => {
    for (const pronounce of [false, true]) {
      expect(compileSpeechSource(source, { pronounce })).toBe(REST_ON_SCREEN);
    }
  });

  // red-at-6ba44ff37: pronunciation output bypassed Option B as well.
  it("whole-cuts a trigger introduced by pronunciation", () => {
    vi.spyOn(speechText, "pronounceable").mockReturnValue("Hello. %41");
    expect(compileSpeechSource("Hello.")).toBe(REST_ON_SCREEN);
  });

  // control: machine-sink recovery must not suppress the direct TTS scan signal.
  it("keeps label budget exhaustion visible to direct TTS callers", () => {
    expect(() => labels.findSecretLabels("z".repeat(524_289))).toThrow("secret label scan budget");
  });

  // red-at-head: each retains prose, an omission or a redacted prefix at HEAD.
  it.each([
    ["H1 joined entity", '<img alt="&lt;!--pass&"><b>#119;ord:</b> hunter2'],
    ["H2 goal label", "Plan is set. <murage-goal>password:</murage-goal> hunter2"],
    ["H3 pre", "<pre>password</pre>\n: hunter2"],
    ["H3 fence", "```\npassword\n```\n: hunter2"],
    ["H3 tilde fence", "~~~\npassword\n~~~\n: hunter2"],
    ["H3 fence info", "```password\n```\n: hunter2"],
    ["H3 table separator", "| password |\n| --- |\n: hunter2"],
    ["H3 table without separator", "| password | hunter2 |"],
    ["H3 bare cells without separator", "password | hunter2"],
    ["H3 indent", "    password\n: hunter2"],
    ["H3 newline after less-than", "Note <\npassword\n: hunter2"],
    ["tag", "Hello. <b>world</b>"],
    ["comment", "Hello. <!-- comment -->"],
    ["processing instruction", "Hello. <?instruction?>"],
    ["hex entity", "Hello. &#x41;"],
    ["decimal entity without semicolon", "Hello. &#65"],
    ["named entity", "Hello. &copy;"],
    ["bare named entity", "Hello. &amp"],
    ["percent prose", "Hello. %41"],
    ["unterminated tag", "Hello. <tag"],
    ["accepted entity cost", "Use &lt;stdio.h&gt; today."],
    ["accepted autolink cost", "See <https://example.test> now."],
    ["accepted fenced tag cost", "Example.\n```\n<div>Hi</div>\n```\nDone."],
  ])("whole-cuts %s", (_name, source) => {
    for (const presentation of [false, true]) {
      expect(compileSpeechSource(source, { presentation })).toBe(REST_ON_SCREEN);
      expect(compileSpeechSource(source, { presentation, prefix: "Alice" })).toBe(REST_ON_SCREEN);
    }
  });

  // red-at-head: prefix and source are protected separately, then joined at HEAD.
  it("whole-cuts a triggered speaker prefix before joining", () => {
    expect(compileSpeechSource("Fine.", { prefix: "Alice <b>x</b>" })).toBe(REST_ON_SCREEN);
    expect(compileSpeechSource("<b>x</b>", { prefix: "Alice" })).toBe(REST_ON_SCREEN);
  });

  // control: HEAD already cuts the unsafe '<'; neither version speaks it unchanged.
  it("keeps the head prose less-than cut", () => {
    expect(compileSpeechSource("a < b")).toBe(`a redacted ${REST_ON_SCREEN}`);
  });

  // control: these are green at HEAD; the parenthesized URL rejects B.1's shorter span.
  it.each([
    ["AT&T", "AT&T"],
    ["See https://example.test/a%20b now.", "See link now."],
    ["See https://example.test/A_(b)%20c now.", "See link now."],
    ["See [guide](A_(b)%20c) now.", "See guide now."],
    ["See ![diagram](A_(b)%20c) now.", "See image omitted now."],
  ])("keeps benign speech: %s", (source, expected) => {
    expect(compileSpeechSource(source)).toBe(expected);
  });

  // red-at-head: HEAD throws on oversize, rather than returning the constant.
  it("whole-cuts oversized source and prefix", () => {
    const source = "a".repeat(MAX_SOURCE_BYTES + 1);
    expect(compileSpeechSource(source, { prefix: "Alice" })).toBe(REST_ON_SCREEN);
    expect(compileSpeechSource("Fine.", { prefix: source })).toBe(REST_ON_SCREEN);
  });

  // red-at-head: depth 33 is unsafe at HEAD but retains 'Hello. redacted'.
  it("whole-cuts 33 nested links on compile and replacement", () => {
    let nested = "a";
    for (let i = 0; i < 33; i++) nested = `[${nested}](b)`;
    const source = `Hello. ${nested}`;
    expect(compileSpeechSource(source, { prefix: "Alice" })).toBe(REST_ON_SCREEN);
    expect(replaced(source)).toEqual([REST_ON_SCREEN, REST_ON_SCREEN]);
  });

  // red-at-head: the shared scan has no budget at HEAD and returns an empty array.
  it("bounds the shared label scan", () => {
    expect(() => labels.findSecretLabels("a".repeat(1024 * 1024 + 1))).toThrow("secret label scan budget");
  });

  // red-at-head: HEAD preserves the latch but seals it as 'redacted', not the constant.
  // Also fails if B.1 drops the head condition: replacement would speak hunter2.
  it("preserves malformed-marker cuts across authoritative replacement", () => {
    expect(replaced("«not our marker» hunter2", "hunter2")).toEqual([REST_ON_SCREEN, REST_ON_SCREEN]);
  });

  // control: HEAD already latches this malformed marker; guards against B.1's replacement.
  it("never releases a malformed-marker suffix after replacement", () => {
    expect(replaced("«not our marker» hunter2", "hunter2").join(" ")).not.toContain("hunter2");
  });

  // control: real server/md-secret-label.test.ts row 22 fixtures, not nonexistent
  // G10/G10b or md-secret-label-r31 fixtures. These test the shared sink contract.
  it.each([
    "the token: leave this prose alone",
    "const token = await getToken();",
    "use a **strong password** here",
    "the `password` field",
    "my_token: x",
  ])("keeps the existing row 22 machine-sink guard: %s", source => {
    expect(redactSecretsForSink(source)).toBe(source);
    expect(redactSecretsForSink(redactSecretsForSink(source))).toBe(source);
  });

  // red-at-head: raw %41 has no head cut; its replacement loses all evidence.
  it("latches an Option B cut before replacement removes the trigger", () => {
    expect(replaced("Hello. %41", "Fine.")).toEqual([REST_ON_SCREEN, REST_ON_SCREEN]);
  });

  // red-at-head: compile lets exceptions escape. Replacement has no raw gate:
  // the size throw escapes in reserveBytes; label/collapse throws never latch a cut.
  it.each(["predicate", "labels", "collapse"] as const)("fails closed on %s exceptions at both entries", (stage) => {
    const inject = () => {
      if (stage === "predicate") vi.spyOn(Buffer, "byteLength").mockImplementationOnce(() => { throw new Error("injected size check"); });
      if (stage === "labels") vi.spyOn(labels, "findSecretLabels").mockImplementationOnce(() => { throw new Error("injected labels"); });
      if (stage === "collapse") vi.spyOn(String.prototype, "split").mockImplementationOnce(() => { throw new Error("injected collapse"); });
    };
    for (const presentation of [false, true]) {
      inject();
      expect(compileSpeechSource("Hello.", { presentation })).toBe(REST_ON_SCREEN);
      vi.restoreAllMocks();
      inject();
      expect(compileSpeechSource("Fine.", { prefix: "Alice", presentation })).toBe(REST_ON_SCREEN);
      vi.restoreAllMocks();
    }
    const sources = new CallSpeechSource();
    const call = sources.open("owner", "thread");
    const reply = sources.begin(call, "bot", "generation");
    sources.append(call, reply, 0, "Hello.");
    // Arm only AFTER the retained head condition, so each replacement throw
    // originates inside optionBCut (including its label scan and collapse).
    const protect = speechSource.protectSpeechSource;
    vi.spyOn(speechSource, "protectSpeechSource").mockImplementation((source, options) => {
      const result = protect(source, options);
      inject();
      return result;
    });
    sources.replace(call, reply, "Replacement.");
    vi.restoreAllMocks();
    sources.seal(call, reply);
    expect(sources.presentation(call, reply)).toBe(REST_ON_SCREEN);
    expect([...sources.drain(call, reply)]).toEqual([REST_ON_SCREEN]);
  });

  // red-at-head: replace has no catch around the retained head oracle either.
  it("fails closed when replacement head protection throws", () => {
    const sources = new CallSpeechSource();
    const call = sources.open("owner", "thread");
    const reply = sources.begin(call, "bot", "generation");
    sources.append(call, reply, 0, "Hello.");
    vi.spyOn(labels, "findSecretLabels").mockImplementationOnce(() => { throw new Error("head oracle"); });
    sources.replace(call, reply, "Replacement.");
    vi.restoreAllMocks();
    sources.seal(call, reply);
    expect(sources.presentation(call, reply)).toBe(REST_ON_SCREEN);
    expect([...sources.drain(call, reply)]).toEqual([REST_ON_SCREEN]);
  });
});

function replaced(source: string, replacement = "Fine."): string[] {
  const sources = new CallSpeechSource();
  const call = sources.open("owner", "thread");
  const reply = sources.begin(call, "bot", "generation");
  sources.append(call, reply, 0, source);
  sources.replace(call, reply, replacement);
  sources.seal(call, reply);
  return [sources.presentation(call, reply), [...sources.drain(call, reply)].join(" ")];
}
