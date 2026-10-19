// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S6 rule 13: a stored name snapshot never reaches a bot. The bot-to-bot channel title is derived from its two member ids at read time
// (dmTitle), so a rename reaches it; speakerCorrection names no one. Test 34 (names) and the 18d snapshot greps.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { dmTitle } from "./dm-title.ts";
import type { GroupRecord } from "./store.ts";

const SERVER = import.meta.dirname;
const INDEX = readFileSync(join(SERVER, "index.ts"), "utf8");
const codeLines = (text: string): Array<{ line: number; code: string }> => text.split("\n").map((code, i) => ({ line: i + 1, code: code.replace(/\s\/\/.*$/, "") }))
  .filter(({ code }) => !/^\s*(\/\/|\*|\/\*)/.test(code));

const roster = (names: Record<string, string>) => ({ bot: (id: string) => (names[id] !== undefined ? { name: names[id]! } : undefined) });
const dm = (extra: Partial<GroupRecord> = {}): Pick<GroupRecord, "name" | "memberIds" | "dm"> => ({ name: "Ada ⇄ Bo", memberIds: ["a", "b"], dm: true, ...extra });

describe("13b: dmTitle", () => {
  it("derives a bot-to-bot channel's title from its two member ids, so a rename reaches it", () => {
    expect(dmTitle(roster({ a: "Ada", b: "Bo" }), dm())).toBe("Ada ⇄ Bo");
    expect(dmTitle(roster({ a: "Ada Lovelace", b: "Bo" }), dm())).toBe("Ada Lovelace ⇄ Bo");
    expect(dmTitle(roster({ a: "Ada", b: "Bonnie" }), dm({ name: "stale snapshot" }))).toBe("Ada ⇄ Bonnie");
  });
  it("a channel that is not a bot-to-bot channel keeps the name its owner gave it", () => {
    expect(dmTitle(roster({ a: "Ada", b: "Bo" }), dm({ dm: false, name: "Launch" }))).toBe("Launch");
    expect(dmTitle(roster({ a: "Ada", b: "Bo" }), dm({ dm: undefined, name: "Launch" }))).toBe("Launch");
  });
  it("a member no longer on the roster keeps the stored title (the only name there is)", () => {
    expect(dmTitle(roster({ a: "Ada" }), dm())).toBe("Ada ⇄ Bo");
    expect(dmTitle(roster({ a: "Ada", b: "Bo" }), dm({ memberIds: ["a"] }))).toBe("Ada ⇄ Bo");
  });
});

describe("13a: speakerCorrection names no one", () => {
  const start = INDEX.indexOf("function speakerCorrection(");
  const body = INDEX.slice(start, INDEX.indexOf("\nfunction ", start + 1));
  const run = (rows: Array<Record<string, unknown>>) => runInNewContext(stripTypeScriptTypes(body) + "\nspeakerCorrection(\"t\", \"me\");", {
    store: { scanNewest: (_t: string, visit: (m: unknown) => boolean) => { for (const row of [...rows].reverse()) if (visit(row)) return; } },
  }) as string;
  it.each([["a bot", "Iris"], ["the owner", "Sean"], ["a teammate", "Dax Teammate"]])("after a cut whose removed speaker is %s", (_who, name) => {
    const text = run([{ role: "bot", kind: "activity", from: { botId: "me", name: "Me" }, removedSpeaker: name }]);
    expect(text).toBe("Murage: Your last reply contained a line written as another speaker. It was removed: they did not say it.\n\n");
    expect(text).not.toContain(name);
  });
  it("says nothing when the last reply had no cut", () => {
    expect(run([{ role: "bot", kind: "text", text: "hi", from: { botId: "me", name: "Me" } }])).toBe("");
  });
});

describe("18d: stored name snapshots outside the owner's lines", () => {
  /** The owner-only lines that may read removedSpeaker: the cut's own write (the removal row for the owner) and speakerCorrection's scan,
   * which asks only whether a cut happened. */
  const REMOVED_SPEAKER_ALLOW = [
    /message\.kind === "text" \|\| message\.removedSpeaker/,
    /const cut = reply\?\.removedSpeaker/,
    /if \(result\.removedSpeaker\) \{/,
    /cutSpeaker = result\.removedSpeaker;/,
    /removedSpeaker: result\.removedSpeaker, removedText: result\.removedText, tool: \{ name: `Removed a line written as \$\{result\.removedSpeaker\}\.`/,
    /cutSpeaker \? \{ removedSpeaker: cutSpeaker \}/,
  ];
  it("index.ts reads removedSpeaker only on the owner's lines", () => {
    const found = codeLines(INDEX).filter(({ code }) => /removedSpeaker/.test(code) && !REMOVED_SPEAKER_ALLOW.some(re => re.test(code)));
    expect(found.map(({ line, code }) => `index.ts:${line}: ${code.trim().slice(0, 120)}`)).toEqual([]);
  });
  it("speakerCorrection renders no stored name", () => {
    const start = INDEX.indexOf("function speakerCorrection(");
    const body = INDEX.slice(start, INDEX.indexOf("\nfunction ", start + 1));
    expect(body).not.toMatch(/\$\{/);
  });
  it("a room's persona line and the owner's group frame take a channel's title from dmTitle", () => {
    const code = codeLines(INDEX).map(({ code }) => code).join("\n");
    expect(code).not.toMatch(/roomPersonaLines\([^)]*\bgroup\.name\b/);
    expect(code).toMatch(/roomPersonaLines\(bot, dmTitle\(store, group\)\)/);
    const frame = code.slice(code.indexOf("function publicGroupState("), code.indexOf("\n}\n", code.indexOf("function publicGroupState(")));
    expect(frame).toMatch(/name: dmTitle\(store, group\)/);
  });
});
