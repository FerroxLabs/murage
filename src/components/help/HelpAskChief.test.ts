// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L4B fallback (1.0.17): the help panel's ask opens the Chief of Staff's chat with the screen named and the
// question in the composer, never sent. On the base the panel only had the promise copy and no ask.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { askChiefAboutScreen, askText, ASK_MAX_CHARS, chiefFor } from "@/lib/help-ask-chief";
import { prefillBotChat, type ComposeIo } from "@/lib/compose-link";
import { resolveHelpScreen } from "@/lib/screen-envelope";
import { hx } from "./help-copy";
import { releaseGate } from "./HelpAskChief";

interface TestBot { id: string; name: string; threadId: string; chiefOfStaff?: boolean; chiefScope?: "workspace"; hidden?: boolean }
const bots: TestBot[] = [
  { id: "b1", name: "Nova", threadId: "t1" },
  { id: "b2", name: "Ada", threadId: "t2", chiefOfStaff: true, chiefScope: "workspace" },
  { id: "b3", name: "Hidden chief", threadId: "t3", chiefOfStaff: true, chiefScope: "workspace", hidden: true },
];

describe("ask about this screen", () => {
  it("opens the Chief's chat with the screen named and the question in its composer", () => {
    const select = vi.fn();
    const drafts = new Map<string, string>();
    const io: ComposeIo = { readDraft: (id) => drafts.get(id) ?? "", setDraft: (id, text) => void drafts.set(id, text), focus: vi.fn() };
    const screen = resolveHelpScreen({ activeView: "today", connected: true });
    const title = hx(screen.entry!.title, screen.params);
    expect(title).toBe("Today");
    const asked = askChiefAboutScreen(bots, title, "  What does Finished in the background mean?  ", {
      select,
      prefill: (chat, text) => prefillBotChat(chat, text, io),
    });
    expect(asked).toBe(true);
    expect(select).toHaveBeenCalledWith("b2");
    expect(drafts.get("bot:b2:t2")).toBe("I am on the Today screen in Murage.\n\nWhat does Finished in the background mean?");
    expect(io.focus).toHaveBeenCalledWith("b2");
  });

  it("names the screen even with no question typed, and keeps words already in the draft", () => {
    const drafts = new Map<string, string>([["bot:b2:t2", "Half a thought"]]);
    const io: ComposeIo = { readDraft: (id) => drafts.get(id) ?? "", setDraft: (id, text) => void drafts.set(id, text), focus: vi.fn() };
    askChiefAboutScreen(bots, "Health", "", { select: vi.fn(), prefill: (chat, text) => prefillBotChat(chat, text, io) });
    expect(drafts.get("bot:b2:t2")).toBe("Half a thought\n\nI am on the Health screen in Murage.");
  });

  it("asks the first bot shown when there is no Chief, and nothing when there are no bots", () => {
    expect(chiefFor([{ id: "x", name: "X", threadId: "tx" }])?.id).toBe("x");
    expect(chiefFor([bots[2]!])).toBeUndefined();
    const select = vi.fn();
    expect(askChiefAboutScreen([], "Today", "hi", { select, prefill: vi.fn() })).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it("bounds what goes into the draft", () => {
    const text = askText("A ".repeat(200), "q".repeat(ASK_MAX_CHARS + 50));
    expect(text.length).toBeLessThan(ASK_MAX_CHARS + 200);
    expect(text).not.toMatch(/[–—]/);
  });

  it("keeps the question on this computer: the box sends nothing and never feeds a feedback report", () => {
    const source = readFileSync(fileURLToPath(new URL("./HelpAskChief.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\bapi\(|fetch\(|buildFeedbackRequest|from "[^"]*FeedbackForm"|sessionStorage|localStorage/);
  });

  // Astra r1 High: a held Enter that pressed Ask must not repeat into the Chief's composer, where Enter sends.
  it("a key-pressed Ask waits for the key to come up; a click asks at once", () => {
    const run = vi.fn();
    const gate = releaseGate(run);
    gate.keyDown("Enter");
    gate.submit();
    expect(run).not.toHaveBeenCalled();
    gate.keyUp("Enter");
    expect(run).toHaveBeenCalledOnce();
    gate.submit();
    expect(run).toHaveBeenCalledTimes(2);
    gate.keyDown("Enter");
    gate.submit();
    gate.cancel();
    gate.keyUp("Enter");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
