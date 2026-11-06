// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 copy (designs/NOLIMITS-V1-CUT.md section 3; text from designs/NOLIMITS-MEANS-IT.md section 11): W (the
// No limits warning), N (the note on an outside-content card, with its source name), O (the OpenClaw exception) and
// O-win (the Windows shell exception), in all 8 packs. locale-copy.test.ts proves dashes, address and wording.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OUTSIDE_SOURCE_KEYS, localizeCallCardText, localizeOutsideNote } from "@/lib/outside-note";
import { outsideTurnNote } from "../../server/auto-approve.ts";
import { callCardText } from "../../server/bot-calls-card.ts";
import type { CallIntent } from "../../server/bot-calls-machine.ts";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const codes = readdirSync(DIR).filter((file) => file.endsWith(".json") && file !== "source-hashes.json").map((file) => file.slice(0, -5)).sort();
const load = (code: string) => JSON.parse(readFileSync(join(DIR, `${code}.json`), "utf8")) as Record<string, string>;
const KEYS = ["noLimits.v1.warning", "noLimits.v1.outsideNote", "noLimits.v1.callOutside", "noLimits.v1.callOutsideUnnamed", "noLimits.v1.openclaw", "noLimits.v1.windows", ...Object.values(OUTSIDE_SOURCE_KEYS)];

describe("NOLIMITS v1 copy in every pack", () => {
  it("ships the 8 packs", () => {
    expect(codes).toEqual(["de", "en", "es", "fr", "hi", "ja", "pt-br", "zh"]);
  });
  for (const code of codes) {
    it(`${code} has W, N, O, O-win and every source name; N keeps {source}`, () => {
      const pack = load(code);
      for (const key of KEYS) expect(pack[key], `${code}:${key}`).toBeTruthy();
      expect(pack["noLimits.v1.outsideNote"]).toContain("{source}");
      for (const key of KEYS) expect(pack[key]).not.toMatch(/—|\bfree\b|\bForge\b/i);
    });
  }
  it("English carries the approved text", () => {
    const en = load("en");
    expect(en["noLimits.v1.warning"]).toBe("No limits runs what you ask without stopping to ask you, even a command Murage cannot read in full. It still asks before a wipe it can see in plain words and before anything your own deny rules name. Once a chat reads something from outside, such as a web page, a search, an email, a download, a cloned project, an unpacked archive, a package install, another person's words or another bot's reply, Murage asks before each command that can run code for the rest of that chat. Commands that only read and print keep running.");
    expect(en["noLimits.v1.outsideNote"]).toBe("This chat read outside content ({source}), so Murage asks before running this. Allow to run it.");
    expect(en["noLimits.v1.openclaw"]).toBe("This bot runs on OpenClaw, which runs commands without asking Murage first. At No limits that stays as it is, even after the chat reads outside content.");
    expect(en["noLimits.v1.windows"]).toBe("Running commands Murage cannot read in full without asking applies to bash and zsh shells; on Windows, Murage keeps asking before PowerShell and cmd commands as it does today.");
  });
});

describe("N on the card: the server's English note, shown in the owner's language", () => {
  const packT = (code: string) => {
    const pack = load(code);
    const en = load("en");
    return (key: string, params?: Record<string, string>) => (pack[key] ?? en[key]!).replace(/\{(\w+)\}/g, (m, name: string) => params?.[name] ?? m);
  };
  it("every source the server can name has a translated name", () => {
    for (const source of Object.keys(OUTSIDE_SOURCE_KEYS)) {
      const held = outsideTurnNote(source as never);
      expect(localizeOutsideNote(held, packT("en"))).toBe(held);
      const de = localizeOutsideNote(held, packT("de"));
      expect(de).not.toBe(held);
      expect(de.startsWith("Dieser Chat hat Inhalte von außen gelesen (")).toBe(true);
    }
  });
  it("a call card's outside line, as the server really writes it, shows in the owner's language; the older call words stay as they came", () => {
    const card = (outside: unknown) => callCardText({ state: "waiting", createdAt: 0, rangAt: null, factFields: { runId: "r", outside } } as unknown as CallIntent, "Scout", () => "14:02")!;
    expect(localizeCallCardText(card("web page"), packT("en"))).toBe(card("web page"));
    expect(localizeCallCardText(card("web page"), packT("de"))).toBe("Scout needs you\nDieser Chat hat zuerst Inhalte von außen gelesen (Webseite).");
    expect(localizeCallCardText(card("not a label"), packT("de"))).toBe("Scout needs you\nDieser Chat hat zuerst Inhalte von außen gelesen.");
    // a line a bot could have typed elsewhere with a source Murage never names is left alone, never turned into our sentence
    expect(localizeCallCardText("This chat read outside content (moon rock) first.", packT("fr"))).toBe("This chat read outside content (moon rock) first.");
    expect(localizeCallCardText("Scout tried to call you at 14:02", packT("ja"))).toBe("Scout tried to call you at 14:02");
    for (const code of codes) {
      expect(load(code)["noLimits.v1.callOutside"], code).toContain("{source}");
      expect(load(code)["noLimits.v1.callOutsideUnnamed"], code).not.toContain("{source}");
    }
  });
  it("a note that is not N is shown as it came", () => {
    expect(localizeOutsideNote("Murage could not read this action whole. Review it before allowing it.", packT("ja"))).toBe("Murage could not read this action whole. Review it before allowing it.");
    // an unknown source name keeps the sentence, with the name as the server wrote it
    expect(localizeOutsideNote("This chat read outside content (moon rock), so Murage asks before running this. Allow to run it.", packT("fr"))).toContain("(moon rock)");
  });
});
