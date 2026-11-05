// Sean 11-04: on calls every reply started with "Hmmm". It was the instant
// "Mm." cue spoken in the bot's voice the moment the owner stopped talking.
// No call or voice code may speak a filler sound, the slow-turn phrases must
// be real words, and a short wait stays silent.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACK_AFTER_MS, ACK_KEYS, AckGate, type AckKey } from "../call-ack";
import { dropOldAckCues, OLD_CUE_DB } from "./ack-cue";

const src = fileURLToPath(new URL("../..", import.meta.url));

/** The client code that makes a call or voice reply sound. */
function voiceSources(): string[] {
  const pick = (dir: string, keep: (name: string) => boolean) =>
    readdirSync(join(src, dir))
      .filter((name) => /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && keep(name))
      .map((name) => join(src, dir, name));
  return [
    ...pick("lib/tts", () => true),
    ...pick("lib", (name) => /^(call|group-call|voice|bot-call)/.test(name)),
    ...pick("components", (name) => /^(Call|GroupCall|Voice|BotCall)/.test(name)),
  ];
}

/** Words the call listens for in what the OWNER said (an "um" at the end of
 *  a line means they are not done). Heard, never spoken. */
const HEARD_ONLY = new Set(["lib/call-turns.ts"]);

/** Source with its comments blanked, so a comment that quotes the old cue is
 *  not mistaken for code that speaks it. Strings are kept as they are. */
function codeOnly(source: string): string {
  return source.replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m.startsWith("/") ? " " : m));
}

/** A whole string literal that is only a hesitation sound. */
const FILLER_LITERAL = /(["'`])\s*(?:h+m+|m{2,}|m+\.|u+[hm]+|e+r+m+|a+h+)[.!?,…]*\s*\1/gi;
/** A spoken phrase that opens with one. */
const FILLER_OPENER = /^\s*(?:h+m+|m{2,}|u+[hm]+|e+r+m+|a+h+|o+h+|えー|ええと|うーん|嗯|呃|额)(?![\p{L}])/iu;

afterEach(() => vi.useRealTimers());

describe("calls never open with a filler sound", () => {
  it("no call or voice source speaks a hesitation sound", () => {
    const files = voiceSources().filter((file) => !HEARD_ONLY.has(file.slice(src.length).replaceAll("\\", "/")));
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap((file) =>
      [...codeOnly(readFileSync(file, "utf8")).matchAll(FILLER_LITERAL)].map((m) => `${file.slice(src.length)}: ${m[0]}`),
    );
    expect(hits).toEqual([]);
  });

  it("every slow-turn phrase in every language is real words, not a filler", () => {
    const dir = join(src, "locales");
    const locales = readdirSync(dir).filter((name) => /^[a-z-]+\.json$/.test(name) && name !== "source-hashes.json");
    expect(locales.length).toBeGreaterThan(5);
    for (const name of locales) {
      const strings = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, string>;
      for (const key of ACK_KEYS) {
        const phrase = strings[key];
        expect(phrase, `${name} ${key}`).toBeTruthy();
        expect(FILLER_OPENER.test(phrase!), `${name} ${key}: ${phrase}`).toBe(false);
      }
    }
  });

  it("the filler checks catch the old cue and its look-alikes", () => {
    for (const sound of ["Mm.", "Hmmm", "Hmm,", "Um", "Uh.", "Erm", "Ah"]) {
      expect(`"${sound}"`.match(FILLER_LITERAL), sound).not.toBeNull();
      expect(FILLER_OPENER.test(`${sound} let me see`), sound).toBe(true);
    }
    expect(FILLER_OPENER.test("Okay, give me a moment.")).toBe(false);
    expect(FILLER_OPENER.test("Hmmm, let me check.")).toBe(true);
  });

  it("reads code, not comments, so a quoted cue in a comment is not a hit", () => {
    const code = codeOnly('// the old "Mm." cue\n/* said "Hmmm" */\nconst a = "Mm.";\nconst url = "http://x/y";');
    expect([...code.matchAll(FILLER_LITERAL)].map((m) => m[0])).toEqual(['"Mm."']);
    expect(code).toContain('"http://x/y"');
  });

  it("a wait under 1.5 s says nothing", () => {
    expect(ACK_AFTER_MS).toBeGreaterThanOrEqual(1_500);
    vi.useFakeTimers();
    const fired: AckKey[] = [];
    const gate = new AckGate({ fire: (key) => void fired.push(key) });
    gate.start(Date.now());
    vi.advanceTimersByTime(1_499);
    expect(fired).toEqual([]);
    gate.realPiece();
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([]);
  });

  it("clears the stored clips of the old cue, and never throws doing it", () => {
    const deleted: string[] = [];
    dropOldAckCues({ deleteDatabase: (name: string) => (deleted.push(name), {} as IDBOpenDBRequest) });
    expect(deleted).toEqual([OLD_CUE_DB]);
    expect(() => dropOldAckCues({ deleteDatabase: () => { throw new Error("blocked"); } })).not.toThrow();
    expect(() => dropOldAckCues(undefined)).not.toThrow();
  });
});
