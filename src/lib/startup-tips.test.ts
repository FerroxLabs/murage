// SPDX-License-Identifier: AGPL-3.0-or-later
// FIRSTRUN-1019 slice B: the daily tips (B1 to B4). The strings are the shipped English tip pack.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStartupPicture, writeStartupPicture } from "../../electron/startup-picture.mjs";
import en from "../locales/startup-tips/en.json";
import {
  STARTUP_TIP_IDS,
  nextTipIndex,
  pickTipIndex,
  rosterForTips,
  shortcutKey,
  startupOs,
  tipText,
  type TipContext,
} from "./startup-tips";

const ctx = (extra: Partial<TipContext> = {}): TipContext => ({ chief: "Sable", mates: ["Nova", "Pepper", "Quill"], os: "mac", phoneAvailable: true, ...extra });
const FACE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30"><circle cx="15" cy="15" r="10" fill="#ff6b35"/></svg>`;

describe("B1 twelve tips, rotation wraps 11 to 0 and survives a restart", () => {
  it("has the twelve tips of the spec, in order, each with a headline, a line and a try", () => {
    expect([...STARTUP_TIP_IDS]).toEqual(["search", "brief", "hire", "drop", "needs", "routines", "byname", "voice", "today", "levels", "phone", "notify"]);
    for (const id of STARTUP_TIP_IDS) {
      for (const part of ["head", "line", "try"]) expect((en as Record<string, string>)[`${id}.${part}`], `${id}.${part}`).toBeTruthy();
    }
  });

  it("moves to the next tip and wraps from 11 to 0; anything odd starts at 0", () => {
    expect(nextTipIndex(0)).toBe(1);
    expect(nextTipIndex(10)).toBe(11);
    expect(nextTipIndex(11)).toBe(0);
    for (const odd of [-1, 12, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(nextTipIndex(odd)).toBe(0);
  });

  it("survives a restart: the index goes through the main writer, a file and the main reader", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr19b-b1-"));
    try {
      let index = 9;
      const seen: number[] = [];
      for (let start = 0; start < 5; start += 1) {
        index = nextTipIndex(index);
        const id = STARTUP_TIP_IDS[index];
        expect(writeStartupPicture({ userData: dir, picture: { v: 1, tipNext: index, faceA: FACE, faceB: FACE, tip: { id, head: "h", line: "l", try: "t" }, at: 1 } })).toBe(true);
        // a new "process": nothing is kept in memory, the next start reads the file
        const read = readStartupPicture({ userData: dir });
        expect(read?.tip.id).toBe(id);
        index = read!.tipNext;
        seen.push(index);
      }
      expect(seen).toEqual([10, 11, 0, 1, 2]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("B2 substitution uses the real Chief and first two teammates", () => {
  it("fills {chief}, {m1} and {m2} from the roster", () => {
    expect(tipText("brief", ctx(), en).line).toBe("Sable reads your calendar and inbox overnight and hands you one page at 8.");
    expect(tipText("drop", ctx(), en).try).toBe("Drag a file onto Nova's chat");
    expect(tipText("byname", ctx(), en)).toMatchObject({ line: "Start with @Pepper and it goes straight to them, with Sable kept in the loop.", try: "“@Pepper, find three papers on pricing”" });
  });

  it("with no teammates it uses the Chief; with one teammate {m2} is that teammate", () => {
    expect(tipText("drop", ctx({ mates: [] }), en).try).toBe("Drag a file onto Sable's chat");
    expect(tipText("byname", ctx({ mates: [] }), en).try).toBe("“@Sable, find three papers on pricing”");
    expect(tipText("byname", ctx({ mates: ["Nova"] }), en).try).toBe("“@Nova, find three papers on pricing”");
  });

  it("cuts a name over 20 characters with an ellipsis, and never re-substitutes a name that looks like a placeholder", () => {
    const long = tipText("brief", ctx({ chief: "The Very Long Named Chief Of Staff" }), en).line;
    expect(long.startsWith("The Very Long Named… reads your calendar")).toBe(true);
    expect(tipText("brief", ctx({ chief: "Exactly twenty chars" }), en).line.startsWith("Exactly twenty chars reads")).toBe(true);
    expect(tipText("drop", ctx({ mates: ["{chief}"] }), en).try).toBe("Drag a file onto {chief}'s chat");
  });

  it("falls back to the plain words when nobody is named, and keeps a sentence start capitalised", () => {
    const line = tipText("brief", ctx({ chief: null, mates: [] }), en).line;
    expect(line.startsWith("Your Chief reads your calendar")).toBe(true);
  });

  it("builds the roster from the bot list: the Chief, then the first two visible non-Chief bots in order", () => {
    const bots = [
      { id: "n", name: "Nova" },
      { id: "s", name: "Sable", chiefOfStaff: true, chiefScope: "workspace" as const },
      { id: "h", name: "Hidden", hidden: true },
      { id: "p", name: "Pepper" },
      { id: "q", name: "Quill" },
    ];
    const roster = rosterForTips(bots, null);
    expect(roster.chief?.name).toBe("Sable");
    expect(roster.mates.map((bot) => bot.name)).toEqual(["Nova", "Pepper", "Quill"]);
    expect(rosterForTips(bots, "p").chief?.name).toBe("Pepper");
    expect(rosterForTips([], null)).toEqual({ chief: null, mates: [] });
  });
});

describe("B3 key text is Cmd+K on Mac and Ctrl+K on Windows and Linux", () => {
  it("uses the real key for this computer", () => {
    expect(tipText("search", ctx({ os: "mac" }), en).try).toBe("Press Cmd+K and type a name");
    expect(tipText("search", ctx({ os: "win" }), en).try).toBe("Press Ctrl+K and type a name");
    expect(tipText("search", ctx({ os: "other" }), en).try).toBe("Press Ctrl+K and type a name");
    expect(shortcutKey("mac")).toBe("Cmd+K");
    expect(shortcutKey("other")).toBe("Ctrl+K");
  });

  it("names the notification surfaces of this OS and maps platform names", () => {
    expect(tipText("notify", ctx({ os: "mac" }), en).line).toBe("A finished job can reach you as a banner, a badge or a quiet pill. Pick any mix.");
    expect(tipText("notify", ctx({ os: "win" }), en).line).toContain("a toast, a taskbar badge or the tray");
    expect(tipText("notify", ctx({ os: "other" }), en).line).toContain("a notification, a badge or the tray");
    expect([startupOs("darwin"), startupOs("win32"), startupOs("linux"), startupOs(undefined)]).toEqual(["mac", "win", "other", "other"]);
  });
});

describe("B4 the phone tip is skipped where phone pairing cannot work", () => {
  it("picks the next available tip, wrapping", () => {
    expect(pickTipIndex(10, ctx())).toBe(10);
    expect(pickTipIndex(10, ctx({ phoneAvailable: false }))).toBe(11);
    expect(pickTipIndex(0, ctx({ phoneAvailable: false }))).toBe(0);
    expect(pickTipIndex(12, ctx({ phoneAvailable: false }))).toBe(0);
  });
});
