// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-L6A part 2: Today during first run, hire in one sentence, the connect
// card's "Not now" and unfinished sign-in (UX-FIRSTRUN-SCALE-1012 1.2, 1.8,
// 1.9; review R1-34). Every block here fails on the 1.0.15 base: the modules,
// the strings and the states are new.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({
  api: async () => ({}),
  useStore: () => ({ state: { bots: [] }, dispatch: () => {} }),
}));

const { HIRE_NAMES, hireProfile, hireReady, hireSentence, suggestHireName } = await import("@/lib/hire-defaults");
const { firstRunCardsLeft, firstRunTodayWords } = await import("./today/FirstRunTodayCard");
const { FirstRunConnectView, connectProvider } = await import("./FirstRunJobsCard");
const { todayModel } = await import("@/lib/today-model");
const { permissionModeOf } = await import("@/lib/permission-mode");
const l6a = (await import("@/locales/en-ux/l6a.json")).default as Record<string, string>;

const source = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("hire in one sentence: defaults", () => {
  it("suggests the first name nobody has, ignoring case and spaces", () => {
    expect(suggestHireName([])).toBe(HIRE_NAMES[0]);
    expect(suggestHireName([" juno ", "IVY"])).toBe("Milo");
  });
  it("numbers the first name once every name is taken", () => {
    expect(suggestHireName([...HIRE_NAMES])).toBe("Juno 2");
    expect(suggestHireName([...HIRE_NAMES, "Juno 2"])).toBe("Juno 3");
  });
  it("keeps the sentence to one line and hires only with a job of a few words", () => {
    expect(hireSentence("  chase\n invoices   now ")).toBe("chase invoices now");
    expect(hireReady("hi")).toBe(false);
    expect(hireReady("chase invoices")).toBe(true);
  });
  it("sends only the name and the job, never an engine", () => {
    const profile = hireProfile(" chase unpaid invoices ", "  ", ["Juno"]);
    expect(profile).toEqual({ name: "Ivy", description: "chase unpaid invoices" });
    expect(Object.keys(profile).sort()).toEqual(["description", "name"]);
  });
});

describe("hire in one sentence: the sheet", () => {
  const sheet = source("./hire/HireBotDialog.tsx");
  it("says the level a new bot really starts on", () => {
    // A new bot carries no auto-approve (server/store.ts createBot), which reads as Ask.
    expect(permissionModeOf({ autoApprove: false, fullAccess: false } as never)).toBe("ask");
    expect(sheet).toMatch(/levelName\(permissionModeOf\(\{ autoApprove: false, fullAccess: false \}\)\)/);
  });
  it("creates through newBot with the profile, and offers Browse templates, Cancel and Hire this bot", () => {
    expect(sheet).toMatch(/type: "newBot",\s*profile: hireProfile\(sentence, name, taken\),\s*onSettled:/);
    for (const key of ["ux.l6a.hire.browse", "ux.l6a.hire.cancel", "ux.l6a.hire.go", "ux.l6a.hire.ask"]) expect(sheet).toContain(`t("${key}"`);
  });
  it("closes only once the bot is made, keeping the draft and saying so on a refusal", () => {
    expect(sheet).toMatch(/if \(error === null\) \{\s*track\("bot_created"\);\s*onClose\(\);/);
    expect(sheet).toMatch(/setHiring\(false\);\s*setFailed\(/);
    expect(l6a["ux.l6a.hire.failed"]).toBeTruthy();
  });
  it("ignores a hire that settles after its sheet was dismissed", () => {
    expect(sheet).toMatch(/onSettled: \(error\) => \{\s*if \(!live\.current\) return;/);
    expect(sheet).toMatch(/useEffect\(\(\) => \(\) => \{ live\.current = false; \}, \[\]\);/);
  });
  it("never hires on Enter in the job box, and keeps focus inside the sheet", () => {
    expect(sheet).not.toMatch(/onKeyDown/);
    expect(sheet).toMatch(/useFocusTrap\(dialog, !browsing, \{ initialFocus: "#hire-bot-job", onEscape: onClose \}\)/);
  });
  it("is what New bot, Today's Hire a bot and the Done card open", () => {
    expect(source("./Sidebar.tsx")).toMatch(/onNewBot=\{\(\) => \{\s*setPlusOpen\(false\);\s*setHireOpen\(true\);/);
    expect(source("./today/TodayView.tsx")).toMatch(/onHire=\{\(\) => setHireOpen\(true\)\}/);
    const done = source("./FirstRunNextCard.tsx");
    expect(done).toMatch(/<HireBotDialog\.Component onClose=/);
    expect(done).not.toMatch(/copy\.hire\.say/);
  });
  it("posts the profile's name and description on newBot", () => {
    const store = source("../state/store.tsx");
    expect(store).toMatch(/type: "newBot"; profile\?: \{ name: string; description: string \}; onSettled\?:/);
    expect(store).toMatch(/\.catch\(\(error: unknown\) => \(action\.onSettled \? action\.onSettled\(error\) : showError\(error\)\)\)/);
    expect(store).toMatch(/body: JSON\.stringify\(\{ name: action\.profile\.name, description: action\.profile\.description \}\)/);
  });
});

describe("Today during first run", () => {
  const step = (id: string, status: string) => ({ id, status }) as never;
  const view = (statuses: string[], nothingCanAnswer = false) =>
    ({ nothingCanAnswer, steps: ["hello", "detect", "flux", "chat", "flow"].map((id, i) => step(id, statuses[i])) }) as never;

  it("counts the cards left before the first result", () => {
    expect(firstRunCardsLeft(null)).toBeNull();
    expect(firstRunCardsLeft(view(["done", "open", "open", "open", "open"]))).toBe(3);
    expect(firstRunCardsLeft(view(["done", "skipped", "blocked", "open", "open"]))).toBe(2);
    expect(firstRunCardsLeft(view(["done", "done", "done", "done", "open"]))).toBe(0);
  });
  it("says three short cards, one, or the result next, with Continue setup", () => {
    expect(firstRunTodayWords(view(["done", "open", "open", "open", "open"]), false)).toMatchObject({ variant: "left", sub: "3 short cards, then your first result.", button: "Continue setup" });
    expect(firstRunTodayWords(view(["done", "done", "done", "open", "open"]), false).sub).toBe("One short card, then your first result.");
    expect(firstRunTodayWords(view(["done", "done", "done", "done", "open"]), false).sub).toBe("Your first result is next.");
    expect(firstRunTodayWords(null, false).sub).toBe("Three short cards, then your first result.");
  });
  it("on a machine with nothing to think with, says so with Open setup (FIRSTRUN 1.9)", () => {
    expect(firstRunTodayWords(view(["done", "skipped", "open", "open", "open"], true), false))
      .toEqual({ variant: "bare", title: "Your bots need a brain first", sub: "Connect Flux Router, or sign in to an AI tool on this computer.", button: "Open setup" });
  });
  it("through a phone or the browser door, says setup finishes on the computer, with no button", () => {
    expect(firstRunTodayWords(view(["open", "open", "open", "open", "open"], true), true)).toMatchObject({ variant: "remote", button: null });
  });
  it("is the card Today renders, not the stand-in", () => {
    expect(source("./shell/lane-slots.tsx")).toMatch(/^export \{ FirstRunTodayCard \} from "@\/components\/today\/FirstRunTodayCard";$/m);
  });
  it("tags Today 'Nothing to think with yet' on a bare machine, and Getting set up otherwise", () => {
    const input = {
      now: new Date(2026, 10, 3, 9), ownerName: "", firstRun: true, connectivity: "online", engine: null, flux: "none",
      needsCount: 0, health: { level: "ok", line: "" }, monthTag: null, clientsTag: null, appsConnected: null,
      quiet: { active: false, until: null }, routines: [], runs: [], botNames: {},
    } as never as Parameters<typeof todayModel>[0];
    expect(todayModel({ ...input, firstRunBare: true }).tags.map((tag) => tag.text)).toEqual(["Nothing to think with yet"]);
    expect(todayModel(input).tags.map((tag) => tag.text)).toEqual(["Getting set up"]);
  });
});

describe("the connect card: Not now and an unfinished sign-in (R1-34)", () => {
  const screen = {
    heading: "One thing first",
    lead: "Connect it and I can start.",
    rows: [
      { need: "gmail" as const, bold: "Gmail", small: "so I can read your mail" },
      { need: "flux" as const, bold: "Flux Router", small: "so I can think" },
    ],
    skipToInput: null,
    elsewhere: "Something else",
    appsUnreadable: false,
  };
  const noop = () => {};
  const render = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(FirstRunConnectView, {
      screen, busy: "", failure: "", desktop: true, onConnect: noop, onSkipToInput: noop, onElsewhere: noop, ...extra,
    } as never));

  it("offers Not now, and once pressed says the job waits here", () => {
    expect(render({ onNotNow: noop })).toContain(">Not now</button>");
    const parked = render({ onNotNow: noop, parked: true });
    expect(parked).not.toContain(">Not now</button>");
    expect(parked).toContain("I will wait here. Connect Gmail when you are ready.");
  });
  it("has no Not now where nothing can be connected from here", () => {
    expect(render({})).not.toContain(">Not now</button>");
  });
  it("says Google did not finish, with Try again and Use a different account", () => {
    const markup = render({ unfinished: "gmail" });
    expect(markup).toContain('data-connect-unfinished="gmail"');
    expect(markup).toContain("Google did not finish the sign-in.");
    expect(markup).toContain(">Try again</button>");
    expect(markup).toContain(">Use a different account</button>");
    expect(render({})).not.toContain("did not finish");
    expect(connectProvider("googlecalendar")).toBe("Google");
  });
  it("marks an unfinished connectApp answer instead of returning silently", () => {
    const card = source("./FirstRunJobsCard.tsx");
    expect(card).toMatch(/if \(!result\.connected\) \{\s*setUnfinished\(\{ need, label: alias \}\);\s*forgetSetupView\(\);\s*return;\s*\}/);
    expect(card).not.toMatch(/if \(!result\.connected\) return;/);
    // A slow account read never reopens a form the owner moved past.
    expect(card).toMatch(/const read = \+\+otherAccountRead\.current;[\s\S]{0,400}read !== otherAccountRead\.current\) return;/);
  });
});

describe("Try again and Use a different account look again first (GrokBuild r1)", () => {
  const card = source("./FirstRunJobsCard.tsx");
  const body = card.slice(card.indexOf("const recheckUnfinished"), card.indexOf("const saveKey"));
  it("goes on with the job when the sign-in finished after the wait", () => {
    expect(body).toMatch(/const mine = connectAppStatusForLabel\(next, label\);\s*if \(mine\.connected\) \{\s*setUnfinished\(null\);\s*appConnected\(need\);/);
  });
  it("reuses the confirmed label only for a failed or expired account, else opens the label form", () => {
    expect(body).toMatch(/if \(mode === "again" && !mine\.pending\) \{\s*void confirmLabel\(need, label, true\);/);
    expect(body).toMatch(/setUnfinished\(null\);\s*setTaken\(null\);\s*setLabelling\(need\);/);
  });
  it("says a failed read and keeps the unfinished line", () => {
    expect(body).toMatch(/if \(!next\) \{\s*setFailure\(appsCopy\.failure\);\s*return;\s*\}/);
  });
  it("wakes the setup read on an unfinished sign-in, and leaving the screen or Not now ends every sign-in state", () => {
    expect(card).toMatch(/setUnfinished\(\{ need, label: alias \}\);\s*forgetSetupView\(\);/);
    expect(card).toMatch(/const elsewhere = async \(\) => \{\s*leaveConnectStates\(\);/);
    expect(card).toMatch(/onSkipToInput=\{\(\) => \{ leaveConnectStates\(\); setStage\("input"\); \}\}/);
    expect(card).toMatch(/onNotNow=\{desktop === true \? \(\) => \{ leaveConnectStates\(\); setParked\(true\); \}/);
  });
  it("clears a cancelled recheck's busy mark when the screen is left", () => {
    expect(card).toMatch(/const leaveConnectStates = \(\) => \{\s*if \(recheckInFlight\.current !== 0 && recheckInFlight\.current === otherAccountRead\.current\) setBusyNeed\(""\);/);
  });
  it("names every app in the waiting line", () => {
    const screen = { heading: "h", lead: "l", rows: [{ need: "gmail" as const, bold: "Gmail", small: "" }, { need: "googlecalendar" as const, bold: "Google Calendar", small: "" }], skipToInput: null, elsewhere: "e", appsUnreadable: false };
    const markup = renderToStaticMarkup(createElement(FirstRunConnectView, { screen, busy: "", failure: "", desktop: true, onConnect: () => {}, onSkipToInput: () => {}, onElsewhere: () => {}, parked: true, onNotNow: () => {} } as never));
    expect(markup).toContain("Connect Gmail or Google Calendar when you are ready.");
  });
});

describe("the new words keep the house rules", () => {
  it("are all in the l6a fragment, with no em dash and no 'safe'", () => {
    const keys = Object.keys(l6a);
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(key.startsWith("ux.l6a.")).toBe(true);
      expect(l6a[key]).not.toMatch(/—|\bsafe/i);
    }
  });
});
