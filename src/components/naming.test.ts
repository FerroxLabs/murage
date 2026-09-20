// One name per thing (0.1.57 sweep, items 4, 9, 10).
//
// Source contracts, not render tests: the words live in a dozen files that
// are 500–2,500 lines each, and what matters is that the workspace has one
// word for each idea — not how any one screen lays it out. A second word for
// the same thing is the defect this file exists to catch.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { en } from "@/locales";
import { settingsSearchResults } from "./SettingsModal";
import { effortLabel } from "@/lib/effort-label";
import { SHORTCUT_GROUPS } from "@/lib/keyboard-shortcuts";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

/** Prose inside a string literal or between JSX tags — what a person reads.
 * An identifier (`room-goal`, `plugins-title`, `roomMembers`), an import and
 * a comment are not prose: prose has a space in it, or is one capitalised
 * word on its own. */
const PROSE = (text: string) =>
  !/[`${}]|\s[?:]\s|&&/.test(text) && (/\s/.test(text) || /^[A-Z][a-z]+$/.test(text));

function visibleWords(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split("\n")) {
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
    if (!code.trim() || /^\s*import /.test(code)) continue;
    for (const [, text] of code.matchAll(/"([^"\\]{2,})"/g)) found.push(text);
    for (const [, text] of code.matchAll(/>([^<>{}]{2,})</g)) found.push(text);
  }
  return found.map((text) => text.trim()).filter(PROSE);
}

const saysRoom = (file: string) =>
  visibleWords(read(file)).filter((text) => /\broom\b/i.test(text));

describe("a chat with bots is a channel, everywhere", () => {
  it.each([
    "./GroupView.tsx",
    "./Composer.tsx",
    "./RoutineCalendarPage.tsx",
    "./TeamExportDialog.tsx",
    "./TeamLibraryPanel.tsx",
    "./MemorySettings.tsx",
    "./MemoryPeople.tsx",
  ])("%s never calls one a room", (file) => {
    expect(saysRoom(file)).toEqual([]);
  });

  it("calls the shared brief 'Channel instructions', and never a bulletin", () => {
    const group = read("./GroupView.tsx");
    expect(group).toContain(">Channel instructions<");
    expect(visibleWords(group).filter((text) => /bulletin/i.test(text))).toEqual([]);
    const shortcut = SHORTCUT_GROUPS.flatMap((group) => group.items).find((item) => item.id === "bulletin");
    expect(shortcut?.description).toBe("Save channel instructions");
    expect(shortcut?.context).toBe("Channel instructions editor");
  });

  it("keeps Telegram, Slack and Discord under 'Messaging apps', findable by the old word", () => {
    const settings = read("./SettingsModal.tsx");
    expect(settings).toContain('label: "Messaging apps"');
    expect(settings).not.toContain('label: "Channels"');
    expect(settingsSearchResults("channels")).toContain("channels");
    expect(settingsSearchResults("telegram")).toContain("channels");
  });
});

describe("a bot is a bot, never an agent", () => {
  it.each(["./RenameTitle.tsx", "./ChatHeader.tsx", "./SettingsPanel.tsx", "./Sidebar.tsx", "./CallView.tsx", "./SpeakButton.tsx", "./ChatView.tsx"])(
    "%s says bot in the words a person reads",
    (file) => {
      expect(visibleWords(read(file)).filter((text) => /\bagents?\b/i.test(text))).toEqual([]);
    },
  );

  it("opens one dialog under one name", () => {
    expect(read("./RenameTitle.tsx")).toContain('title="Bot settings"');
    expect(read("./RenameTitle.tsx")).toContain('title="Rename bot"');
    expect(read("./ChatHeader.tsx")).toContain('title="Bot settings"');
    expect(read("./Sidebar.tsx")).toContain('"Bot settings"');
    expect(read("./Sidebar.tsx")).not.toContain('"Edit Profile"');
    expect(en["chatHeader.usageDetail"]).toContain("Bot settings");
  });
});

describe("skills are skills, and 'Add a skill' opens them", () => {
  it("counts skills, not playbooks, on a library card", () => {
    const library = read("./TeamLibraryPanel.tsx");
    expect(visibleWords(library).filter((text) => /playbook/i.test(text))).toEqual([]);
    expect(library).toContain('entry.skills.length === 1 ? "skill" : "skills"');
  });

  it("lands on the Skills tab from both doors into it", () => {
    expect(read("./Sidebar.tsx")).toContain('showTeamLibrary", botId: bot.id, view: "skills"');
    expect(read("./SettingsPanel.tsx")).toContain('showTeamLibrary", botId: bot.id, view: "skills"');
  });

  it("titles the dialog by where you came from, and says Close", () => {
    const library = read("./TeamLibraryPanel.tsx");
    expect(library).toContain('view === "skills" ? "Skills" : view === "bots" ? "Templates" : "Library"');
    expect(library).toContain('aria-label="Close"');
    expect(library).not.toContain('aria-label="Close teams"');
  });
});

describe("routines are routines", () => {
  it("names the sidebar row and the page after the thing, not the grid", () => {
    const sidebar = read("./Sidebar.tsx");
    expect(sidebar).toContain(">Routines</span>");
    expect(sidebar).not.toContain(">Calendar</span>");
    expect(sidebar).toContain('label: "Routines"');
    expect(read("./RoutineCalendarPage.tsx")).toContain(">Routines</h1>");
  });

  it("stops calling the same thing a scheduled task or a calendar event", () => {
    const computer = read("./ComputerPanel.tsx");
    expect(visibleWords(computer).filter((text) => /scheduled tasks?|create schedule/i.test(text))).toEqual([]);
    const page = read("./RoutineCalendarPage.tsx");
    expect(visibleWords(page).filter((text) => /calendar event/i.test(text))).toEqual([]);
  });

  it("offers Repeat in the quick form, not only under More options", () => {
    const page = read("./RoutineCalendarPage.tsx");
    const quick = page.slice(page.indexOf("function QuickComposer("), page.indexOf("function CalendarEventCard("));
    expect(quick).toContain('aria-label="Repeat"');
    expect(quick).toContain('<option value="daily">Daily</option>');
    // and what it chose is what gets saved, not a hardcoded one-off
    expect(quick).toContain("schedule: makeCalendarSchedule(recurrence, seed.at,");
    expect(quick).not.toContain('schedule: { type: "once", at: seed.at }');
  });
});

describe("connected apps", () => {
  it("is called Connected apps on its own panel, not Plugins", () => {
    const panel = read("./PluginsPanel.tsx");
    expect(panel).toContain(">Connected apps</h2>");
    expect(visibleWords(panel).filter((text) => /\bplugins?\b/i.test(text))).toEqual([]);
  });

  it("says what the key unlocks, without a number nobody has verified", () => {
    expect(read("./PluginsPanel.tsx")).toContain("One Flux Router key connects hundreds of apps, including Gmail, Slack, Notion and GitHub.");
    for (const value of Object.values(en)) expect(value).not.toMatch(/\d+\+ (?:more|apps)|and \d+\+ more/);
    expect(Object.values(en).filter((value) => /FluxRouter/.test(value))).toEqual([]);
  });

  it("points a bot's Access at the panel that actually holds apps", () => {
    const settings = read("./SettingsPanel.tsx");
    expect(settings).toContain("Connect apps first (Tools → Connected apps), then give this bot access.");
    expect(settings).not.toContain("Connect apps in App Settings");
  });
});

describe("the copy quick wins", () => {
  it("does not say Discord is coming soon above a working Discord card", () => {
    const telegram = read("./TelegramSettings.tsx");
    expect(telegram).toContain("WhatsApp: coming soon.");
    expect(telegram).not.toContain("Discord and WhatsApp: coming soon.");
    expect(read("./SettingsModal.tsx")).toContain("<DiscordSettings />");
  });

  it("counts one bot as one bot", () => {
    const starter = read("./StarterProfiles.tsx");
    expect(starter).toContain('{profile.members === 1 ? "bot" : "bots"}');
    expect(starter).not.toContain("{profile.members} bots ·");
  });

  it("asks about a bot's actions in possessive English", () => {
    expect(read("./PermissionModeMenu.tsx")).toContain("How should {botName}’s actions be approved?");
  });

  it("spells an effort level the same way in both places", () => {
    expect(effortLabel("xhigh")).toBe("X-High");
    expect(effortLabel("medium")).toBe("Medium");
    expect(effortLabel(undefined)).toBe("Default");
    expect(read("./ModelPicker.tsx")).toContain("{effortLabel(level)}");
    expect(read("./SettingsPanel.tsx")).toContain("{effortLabel(level)}");
    expect(read("./SettingsPanel.tsx")).not.toContain("(Default: no level is sent)");
  });
});
