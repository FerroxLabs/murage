// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PHONE_COPY, phoneInstructionLines } from "./copy.ts";
import { GENERIC_TEXT } from "../../shared/mobile-push.ts";
import { activityText } from "../routes/phones.ts";

const banned = ["sa" + "fe", "unsa" + "fe", "sa" + "fety"];
describe("phone copy", () => {
  it("has no em dash and no banned word", () => {
    const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
    // PHONE_COPY (the job card "say" lines, activity rows and device-job push sentence included) plus the one generic push line that stays in shared/mobile-push.ts
    for (const s of [...strings(PHONE_COPY), ...strings(GENERIC_TEXT["device-job"])]) {
      expect(s).not.toMatch(/—/);
      for (const w of banned) expect(s.toLowerCase()).not.toMatch(new RegExp(`\\b${w}\\b`));
    }
  });
  it("carries the plan's exact strings", () => {
    expect(PHONE_COPY.withheld).toBe("I can use your phone only when you ask me directly, in our own chat.");
    expect(PHONE_COPY.timeout).toBe("Asked on your phone; it did not run. Open Murage on the phone and ask again.");
    expect(PHONE_COPY.declined).toBe("Not allowed on the phone this time.");
    expect(PHONE_COPY.accessChanged).toBe("The phone's access changed.");
    expect(PHONE_COPY.mayHaveRun).toBe("May have run on the phone; read it back before repeating.");
    expect(PHONE_COPY.notOnScreen).toBe("You'll get a request on your phone; open Murage there to allow it.");
    expect(PHONE_COPY.oldApp).toBe("Update the Murage app on your phone");
    expect(PHONE_COPY.passcode).toBe("Set a passcode on this phone, then pair again");
    expect(PHONE_COPY.cloud).toBe("Coming to Murage Cloud");
    expect([...PHONE_COPY.sheetResults]).toEqual(["opened for you to send", "dialer opened"]);
  });
  it("instruction lines cover reads, shown changes, taps, ids, naming and read-back", () => {
    const text = PHONE_COPY.instructions.join(" ").toLowerCase();
    for (const word of ["quiet", "shown", "taps", "ids", "name the phone", "read it back"]) expect(text).toContain(word);
  });
  it("picks lines by grant, offer, authority and mount", () => {
    expect(phoneInstructionLines({ hasGrant: false, offered: true, authority: false, mounted: false })).toEqual([]);
    expect(phoneInstructionLines({ hasGrant: true, offered: false, authority: false, mounted: false })).toEqual([]);
    expect(phoneInstructionLines({ hasGrant: true, offered: true, authority: false, mounted: false })).toEqual([PHONE_COPY.withheld]);
    expect(phoneInstructionLines({ hasGrant: true, offered: true, authority: true, mounted: true })).toEqual([...PHONE_COPY.instructions]);
    expect(phoneInstructionLines({ hasGrant: true, offered: true, authority: true, mounted: false })).toEqual([]);
  });
  it("keeps the moved owner-visible lines exactly as they were", () => {
    expect(PHONE_COPY.say["calendar.read"]).toBe("read your calendar");
    expect(PHONE_COPY.say["calls.dial"]).toBe("open the dialer with a number");
    expect(Object.keys(PHONE_COPY.say).sort()).toEqual(Object.keys(PHONE_COPY.did).sort());
    expect(activityText("calendar.read", "ios")).toBe("Read your calendar on the iPhone");
    expect(activityText("alarms.timer", "android")).toBe("Started a timer on the Android phone");
    expect(activityText("nothing.known", undefined)).toBe("Used your phone on your phone");
    expect(`Ada${PHONE_COPY.pushWants[0]}${PHONE_COPY.capabilityNoun.calls}${PHONE_COPY.pushWants[1]}`).toBe("Ada wants to use your phone calls. Open Murage to allow it.");
  });
  it("S40: withheldVia is exact, and a via turn gets it only when the bot has a grant", () => {
    expect(PHONE_COPY.withheldVia).toBe("I can use your phone only when you ask me directly in our chat. Tap Ask again to do that.");
    expect(phoneInstructionLines({ hasGrant: true, offered: true, authority: false, mounted: false, via: true })).toEqual([PHONE_COPY.withheldVia]);
    expect(phoneInstructionLines({ hasGrant: true, offered: true, authority: false, mounted: true, via: true })).toEqual([PHONE_COPY.withheldVia]);
    // the owner's own turn without authority keeps Part 1's line
    expect(phoneInstructionLines({ hasGrant: true, offered: true, authority: false, mounted: false, via: false })).toEqual([PHONE_COPY.withheld]);
    expect(phoneInstructionLines({ hasGrant: true, offered: true, authority: false, mounted: false })).toEqual([PHONE_COPY.withheld]);
    // no grant: neither
    expect(phoneInstructionLines({ hasGrant: false, offered: true, authority: false, mounted: false, via: true })).toEqual([]);
    expect(phoneInstructionLines({ hasGrant: false, offered: true, authority: false, mounted: false, via: false })).toEqual([]);
  });
  it("S40: the new web keys and the store lines carry no em dash, banned word or vendor and tech name", () => {
    const whatsNew = [
      "Share links, photos and files from any app straight into a chat with your bots.",
      "Ask your bots from anywhere on your phone, by voice or with one tap.",
      "You can make Murage your phone's assistant app.",
    ];
    const en = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/locales/en.json", import.meta.url)), "utf8")) as Record<string, string>;
    const keys = ["phone.ask.fromPhone", "phone.ask.askAgain", "phone.ask.settingTitle", "phone.ask.settingOff", "phone.ask.errorGone", "phone.ask.errorUpdate", "phone.ask.errorSetup"];
    for (const k of keys) expect(typeof en[k]).toBe("string");
    expect(keys.map((k) => en[k])).toEqual([
      "From your phone", "Ask again", "Share and ask from this phone", "Sharing and asking are off for this phone.",
      "That chat is no longer available. Pick another.", "Update Murage on your computer to use this.", "Open Murage to set up sharing again.",
    ]);
    const names = ["Anthropic", "OpenAI", "Google", "xAI", "Moonshot", "Alibaba", "Cursor", "Factory", "DeepSeek", "Zhipu", "Mistral", "Meta", "Claude", "Codex", "Gemini", "Grok", "Kimi", "Qwen", "iOS", "Android", "Siri", "Apple", "iPhone"];
    for (const s of [...whatsNew, ...keys.map((k) => en[k]!), PHONE_COPY.withheldVia]) {
      expect(s).not.toMatch(/—/);
      for (const w of banned) expect(s.toLowerCase()).not.toMatch(new RegExp(`\\b${w}\\b`));
      for (const n of names) expect(s).not.toMatch(new RegExp(`\\b${n}\\b`, "i"));
    }
  });
});
