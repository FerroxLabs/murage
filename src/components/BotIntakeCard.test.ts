// The intake card's contract, read out of its own source.
//
// Source contracts, not render tests: the renderer suite runs in a node
// environment with no DOM (see SkillAffordances.test.ts, whose style this
// copies). What is worth pinning here is not how the card looks — it is the
// handful of decisions that made it dangerous:
//
//   • typing "hi" produced EIGHT pre-ticked skills,
//   • in a card 1,379px tall on a 937px viewport with no scrollbar,
//   • on a bot that was already configured, offering to rename it.
//
// Every assertion below is one of those three, or the escape hatch each of
// them needs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const card = read("./BotIntakeCard.tsx");
const chat = read("./ChatView.tsx");
const settings = read("./SettingsPanel.tsx");

const profileEntry = card.slice(card.indexOf("export function BotSetupAction("));

/** The question's render body — so an assertion cannot be satisfied by a
 *  comment at the top of the file. */
const body = card.slice(card.indexOf("function IntakeQuestion("), card.indexOf("export function BotSetupAction("));

describe("nothing is pre-ticked", () => {
  it("clears the selection when an answer arrives", () => {
    // The defect, exactly: `setChosen(new Set(result.skills.map((s) => s.id)))`
    // ticked every returned skill, so "Find it" was a one-press install of
    // whatever bm25 ranked.
    expect(card).toContain("setChosen(new Set());");
    expect(card).not.toMatch(/setChosen\(new Set\(result\.skills/);
  });

  it("the button counts what is TICKED, never what came back", () => {
    expect(card).toContain("addSkillsLabel(bot.name, chosen.size)");
    expect(card).toContain("disabled={chosen.size === 0");
    expect(card).not.toContain("addSkillsLabel(bot.name, looseSkills.length)");
  });
});

describe("zero clear matches is an answer, with one way out", () => {
  it("offers exactly one action, and it is the library", () => {
    const empty = body.slice(body.indexOf("looseSkills.length === 0"));
    expect(empty).toContain("Browse the library");
    expect(empty).toContain("browseLibrary");
  });

  it("that action opens the library on SKILLS with this bot preselected", () => {
    expect(card).toContain('dispatch({ type: "showTeamLibrary", botId: bot.id, view: "skills" })');
  });
});

describe("the card never exceeds the viewport", () => {
  it("is bounded against the VISUAL viewport, which shrinks for a keyboard", () => {
    // `100vh` is the wrong number on iOS — it keeps its pre-keyboard value,
    // which is how a bounded card still ends up under the keyboard.
    expect(card).toContain("var(--vvh");
    expect(card).toContain("maxHeight: CARD_MAX_HEIGHT");
    expect(card).toMatch(/CARD_MAX_HEIGHT\s*=\s*"min\(/);
  });

  it("scrolls INSIDE the bound rather than growing past it", () => {
    expect(body).toContain("overflow-hidden rounded-2xl");
    expect(body).toContain("min-h-0 flex-1 overflow-y-auto");
  });

  it("keeps the question and the dismiss out of the scroller entirely", () => {
    // Sticky can be defeated; being outside the scrolling element cannot.
    const header = body.slice(body.indexOf('className="shrink-0 p-4 pb-0"'), body.indexOf("min-h-0 flex-1 overflow-y-auto"));
    expect(header).toContain("What do you mostly want help with?");
    expect(header).toContain('aria-label="Hide this question"');
    expect(header).toContain('aria-label="What do you mostly want help with?"');
  });

  it("the dock it lives in cannot be taller than the pane", () => {
    expect(chat).toContain("dock-safe-bottom absolute inset-x-0 bottom-0 z-[2] flex max-h-full flex-col");
  });
});

describe("the composer belongs to the conversation", () => {
  it("has no card docked above it at all any more", () => {
    // The verdict this deletion implements, verbatim: it must be a
    // conversation FROM THE BOT, not an options box at the bottom. A quieter
    // chip in the same place would have been the same noise in the same
    // place, so the whole entry point is gone rather than reduced.
    expect(card).not.toContain("export function BotIntakeCard(");
    expect(chat).not.toContain("BotIntakeCard");
    expect(chat).not.toContain("Set {bot.name} up");
  });

  it("takes its private dismissal record with it", () => {
    // Per-bot, per-machine localStorage: it existed only to remember that
    // someone had waved the docked card away. Nothing else read it, and a
    // conversation has nothing to wave away.
    expect(card).not.toContain("murage.intake.dismissed");
    expect(card).not.toContain("localStorage");
  });

  it("asks in the transcript instead, and the transcript can reach it", () => {
    // The one thing that would make this deletion a regression is deleting
    // the docked card and wiring nothing in its place: a new bot would say
    // hello and offer no way to set itself up anywhere on the screen.
    expect(chat).toContain("<IntakeTurn bot={bot} message={m} />");
    expect(chat).not.toContain("intakeOwnsTheQuestion");
  });
});

describe("setup is somewhere you go and ask for it", () => {
  it("lives on the bot's own profile, beside the role control", () => {
    // Removing the composer entry is only safe because this exists. An agent
    // with no skills and no way anywhere in the app to ask for some is the
    // one-way door the whole feature was built to remove.
    expect(settings).toContain('import { BotSetupAction } from "./BotIntakeCard";');
    expect(settings).toMatch(/<BotSetupAction bot=\{bot\} \/>[\s\S]{0,600}<BotRoleControl/);
    expect(profileEntry).toContain("Set up this bot");
  });

  it("is offered on EVERY bot, however configured", () => {
    // No `return null` anywhere in this component: it is never absent.
    expect(profileEntry).not.toContain("return null");
  });

  it("WARNS before it touches an established agent, naming what it would touch", () => {
    expect(profileEntry).toContain("const warns = setupWouldOverwrite(skillCount, bot);");
    expect(profileEntry).toContain("const reasons = setupOverwriteReasons(skillCount, bot);");
    // The warning is a GATE, not a banner: the question is not reachable until
    // it has been acknowledged, and `acknowledged` starts false whenever
    // `warns` is true.
    expect(profileEntry).toContain("if (!acknowledged) {");
    expect(profileEntry).toContain("setAcknowledged(!warns);");
    expect(profileEntry).toContain("is already set up");
    expect(profileEntry).toContain("listPhrase(reasons)");
    // The question renders only after that gate.
    expect(profileEntry.indexOf("if (!acknowledged) {")).toBeLessThan(
      profileEntry.indexOf("<IntakeQuestion bot={bot} autoFocus"),
    );
  });

  it("lets the person continue or cancel, and changes nothing either way", () => {
    expect(profileEntry).toContain("Continue anyway");
    expect(profileEntry).toContain("Cancel");
    expect(profileEntry).toContain("Existing skills are not removed.");
  });

  it("keeps the name on this path too — Sable is never renamed by her own profile", () => {
    // Same `IntakeQuestion`, so the keep-the-name checkbox and its default
    // cannot differ between the two entry points.
    expect(profileEntry).toContain("<IntakeQuestion bot={bot} autoFocus onDismiss=");
  });
});

describe("the name is kept unless the person says otherwise", () => {
  it("offers the choice, pre-selected to keep", () => {
    expect(card).toContain("useState(true)");
    expect(card).toContain("Keep the name {bot.name}");
    expect(card).toContain("checked={keepName}");
  });

  it("sends the choice through to the route", () => {
    expect(card).toContain("applyProfileToBot(bot.id, profile.slug, api, { rename: !keepName })");
    expect(card).toContain("applyProfileDetail(profile, bot.name, !keepName)");
  });
});

describe("the phone is told the truth before the press, not after", () => {
  it("uses the SHARED surface hook, and keeps no copy of its own", () => {
    // This asserted `from "@/lib/surface"` and `knownSurface()` — the card's
    // own private four-line hook, which asked the harness and never checked
    // the Electron preload bridge. On the desktop, served as a production
    // bundle, /api/config answers "remote", so the card decided the desktop
    // was a phone and rendered "Add this on your desktop" as dead text beside
    // a button the person at the keyboard could not press.
    //
    // The assertion was pinning the bug. It now pins the fix: one answer, one
    // place, and no second copy allowed back in.
    expect(card).toContain('import { useDesktopSurface } from "@/lib/use-surface"');
    expect(card).not.toContain("knownSurface()");
    expect(card).not.toContain('from "@/lib/surface"');
  });

  it("renders the neutral thing while the answer is unknown", () => {
    // `undefined` is a real state. Rendering the desktop affordance for one
    // frame on a phone is the bug the seam exists to prevent; rendering the
    // phone message on a desktop is a lie that outlives the fetch.
    expect(card).toContain("desktop === false ?");
    expect(card).toContain("desktop !== true");
    expect(card).not.toContain("desktop === undefined ? true");
  });

  it("says what to do instead, and fires no request", () => {
    expect(card).toContain('const DESKTOP_ONLY = "Add this on your desktop"');
    expect(card).toContain('if (!profile || busy || desktop !== true) return;');
    expect(card).toContain('if (chosen.size === 0 || busy || desktop !== true) return;');
  });
});
