// Every control the desktop hover rail offers is reachable from a phone.
//
// Source contracts, for the same reason TranscriptWidth.test.ts is: the
// renderer suite runs in node with no DOM, and the two transcripts are ~1,500
// lines each. What a person actually does — tap a bubble, hit a 44px row —
// is proved in a browser by src/e2e/message-actions.human.spec.ts. What this
// file pins is that the two transcripts still carry the wiring that spec
// depends on, and that the phone's action list is derived from the same
// predicates the hover rail is, rather than drifting away from it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const chat = read("./ChatView.tsx");
const group = read("./GroupView.tsx");
const styles = read("../styles.css");
const views: Array<[string, string]> = [["ChatView", chat], ["GroupView", group]];

describe("the bubble is the trigger", () => {
  it.each(views)("%s opens the sheet from a tap on the bubble itself", (_name, source) => {
    // The trigger is the bubble because the bubble is the one thing already
    // in the row. Any NEW element would inherit the row's `gap-1.5` — 6px of
    // the width the `max-md:hidden` fix just bought back.
    expect(source).toMatch(/data-testid="msg-bubble"[\s\S]{0,400}?onClick=/);
    expect(source).toContain("bubbleTapOpensActions");
    expect(source).toContain("BUBBLE_INTERACTIVE");
  });

  it.each(views)("%s gates the whole thing on being below md", (_name, source) => {
    // `narrow` is read once per transcript (one matchMedia subscription, not
    // one per row) and threaded down. Above `md` the bubble is not focusable,
    // announces no popup, and its click handler returns early — desktop is
    // exactly what it was.
    expect(source).toContain("useNarrowViewport");
    expect(source).toContain("tabIndex={narrow ? 0 : undefined}");
    expect(source).toContain('aria-haspopup={narrow ? "dialog" : undefined}');
  });

  it.each(views)("%s answers a keyboard as well as a thumb", (_name, source) => {
    // A 44px target is no use to someone on a keyboard. Enter and Space open
    // the same sheet, and the bubble's focus ring comes from BUBBLE_TAPPABLE.
    expect(source).toMatch(/event\.key !== "Enter" && event\.key !== " "/);
    expect(source).toContain("BUBBLE_TAPPABLE");
  });

  it.each(views)("%s renders the sheet", (_name, source) => {
    expect(source).toContain("<MessageActionSheet");
  });
});

/** Just the sheet's action list, cut out of the file.
 *
 *  Scoped deliberately: "Reply", "Regenerate response" and the conditions
 *  that gate them all appear in the hover rail a few lines above, so a
 *  whole-file `toContain` would pass on the rail's copy and prove nothing
 *  about the sheet. Cutting the list out is what makes these assertions able
 *  to fail. */
function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  expect([start, end].every((i) => i > 0)).toBe(true);
  return source.slice(start, end);
}
const chatSheet = slice(chat, "const actions: MessageAction[] =", "const openFromTap");
const groupSheet = slice(group, "const roomActions = (m: Message)", "  return (");

describe("the hover rail's controls, as words", () => {
  it("offers a 1:1 message everything its rail does", () => {
    // The rail: edit, copy, reply, pin on a user message; copy, speak,
    // regenerate, reply, pin on a bot one. Nothing on it may be desktop-only.
    for (const label of [
      "Copy message",
      "Reply",
      "Edit message",
      "Regenerate response",
      "Read aloud",
    ]) {
      expect(chatSheet).toContain(`"${label}"`);
    }
    expect(chatSheet).toMatch(/pinned \? "Unpin message" : "Pin message"/);
  });

  it("derives the sheet from the same conditions the rail is drawn from", () => {
    // Parity is only real if it cannot drift. Editing rewinds the thread, so
    // it waits for the turn to end; regenerate is offered on the last bot
    // message only. The sheet asks both questions the way the rail asks them.
    expect(chatSheet).toMatch(/message\.kind === "text" && !webhookView && !bot\.busy/);
    expect(chatSheet).toMatch(/isLastBotText && !bot\.busy && onRegenerate/);
  });

  it("keeps the speak control in the list when it is not ready, and says why", () => {
    // SpeakButton's own rule, quoted: "a hidden button is a feature nobody
    // discovers". On a phone that matters more, not less — there is no
    // tooltip to hover for the reason.
    expect(chatSheet).toContain("Add an ElevenLabs key to read messages aloud");
    expect(chatSheet).toContain("Pick a voice in this agent's profile to read aloud");
    expect(chatSheet).toContain("Stop speaking");
  });

  it("offers a channel message its rail's pair", () => {
    // GroupView's rail is Reply and Pin, so the channel sheet is Reply and
    // Pin. It carries no fourth control the desktop row does not have.
    expect(groupSheet).toContain('id: "reply"');
    expect(groupSheet).toContain('id: "pin"');
    expect(groupSheet).toMatch(/pinned \? "Unpin message" : "Pin message"/);
  });

  it("shows the timestamp the phone lost with the rail", () => {
    // `group-hover:opacity-100 max-md:hidden` — the hover-revealed time is
    // gone below md too. The sheet's heading is where it comes back.
    expect(chat).toMatch(/heading=\{`.*formatTime\(message\.at\)\}`\}/);
    expect(group).toMatch(/heading=\{`.*formatTime\(m\.at\)\}`\}/);
  });
});

describe("the sheet behaves like a dialog", () => {
  it("is modal, labelled, and portalled out of the transcript", () => {
    expect(chat).toContain("createPortal");
    expect(chat).toContain('aria-modal="true"');
    expect(chat).toContain('aria-label="Message actions"');
  });

  it("can be left by escape, by the ground, and by a control of its own", () => {
    // Three ways out, because the sheet covers the composer: a phone that
    // opened one by accident must never be stuck in it.
    expect(chat).toMatch(/event\.key === "Escape"/);
    expect(chat).toMatch(/SHEET_BACKDROP\}\s+onClick=\{onClose\}/);
    expect(chat).toMatch(/Close</);
  });

  it("moves focus in and gives it back", () => {
    expect(chat).toContain("previous?.focus()");
    expect(chat).toMatch(/event\.key !== "Tab"/);
  });
});

describe("motion is optional", () => {
  it("switches the sheet's animation off for a reader who asked", () => {
    const reduced = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.msg-sheet,\s*\.msg-sheet-backdrop\s*\{\s*animation:\s*none;?\s*\}/);
  });
});
