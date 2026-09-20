// Channels done right, and projects. Four screens changed, and what has to
// be true of them is mostly what a person can SEE and REACH, not how any one
// of them lays its markup out. So these are source contracts, in the shape
// naming.test.ts already uses in this folder: the words a person reads, and
// the controls that have to exist for a given action to be possible at all.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// From the lib module, not from the components: a component in this app
// reads `window` at import time, and the suite runs in node.
import {
  CHANNEL_DETAILS_SECTIONS,
  CHANNEL_DETAILS_SECTION_LABELS,
  PROJECT_STATUS_NOTES,
  channelNoun,
  projectTimingLine,
  roomMemorySentence,
} from "@/lib/channel-surface";
import { CHANNEL_PROJECT_STATUSES, CHANNEL_PROJECT_STATUS_LABELS } from "../../shared/project";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const GROUP_VIEW = read("./GroupView.tsx");
const SIDEBAR = read("./Sidebar.tsx");
const DETAILS = read("./ChannelDetailsPanel.tsx");
const PROJECT_HOME = read("./ProjectHome.tsx");

const LANE_FILES: Array<[string, string]> = [
  ["GroupView.tsx", GROUP_VIEW],
  ["Sidebar.tsx", SIDEBAR],
  ["ChannelDetailsPanel.tsx", DETAILS],
  ["ProjectHome.tsx", PROJECT_HOME],
];

/** Prose inside a string literal or between JSX tags — what a person reads.
 * Same rule naming.test.ts uses: an identifier, an import and a comment are
 * not prose, because prose has a space in it or is one capitalised word. */
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

describe("the channel header can do the things a channel has", () => {
  it("offers Details beside the controls that were already there", () => {
    expect(GROUP_VIEW).toContain("Details for ${group.name}");
    expect(GROUP_VIEW).toContain(">Details<");
  });

  it("holds the five channel actions behind one menu, named the way a person would say them", () => {
    const menu = GROUP_VIEW.slice(
      GROUP_VIEW.indexOf("function ChannelHeaderMenu("),
      GROUP_VIEW.indexOf("function RenameChannelDialog("),
    );
    expect(menu).toContain("Channel details");
    expect(menu).toContain("Make this a project");
    expect(menu).toContain("Rename");
    expect(menu).toContain("Archive");
    expect(menu).toContain("Delete ");
    // A menu, and reachable without a mouse: it is labelled as one and
    // Escape closes it.
    expect(menu).toContain('role="menu"');
    expect(menu).toContain('role="menuitem"');
    expect(menu).toContain("Escape");
  });

  it("never offers to make a project out of something that already is one", () => {
    const menu = GROUP_VIEW.slice(
      GROUP_VIEW.indexOf("function ChannelHeaderMenu("),
      GROUP_VIEW.indexOf("function RenameChannelDialog("),
    );
    expect(menu).toContain("{!group.channelProject && (");
  });

  it("asks before deleting, and archives without asking, because one is reversible", () => {
    expect(GROUP_VIEW).toContain("<ConfirmDelete");
    expect(GROUP_VIEW).toContain('patch: { hidden: true }');
  });
});

describe("making a channel a project", () => {
  it("asks for the goal and nothing else, and says what it keeps", () => {
    const dialog = GROUP_VIEW.slice(
      GROUP_VIEW.indexOf("function MakeProjectDialog("),
      GROUP_VIEW.indexOf("export function GroupView("),
    );
    expect(dialog).toContain("What are you trying to get done?");
    expect(dialog).toContain("The chat, the bots, the instructions and the folder all stay.");
    // one field, and it is the goal
    expect(dialog.match(/<textarea/g)?.length).toBe(1);
    expect(dialog).not.toMatch(/<input/);
  });

  it("creates a project in one call, with its goal doubling as the instructions", () => {
    const panel = SIDEBAR.slice(SIDEBAR.indexOf("function NewRoomPanel("), SIDEBAR.indexOf("/** Move-to-section popover"));
    expect(panel).toContain("What is it about?");
    expect(panel).toContain("This becomes the instructions every bot in here follows.");
    expect(panel).toContain("bulletin: goal.trim(), channelProject: { goal: goal.trim() }");
    // a project with no goal is not a project, so the button stays off
    expect(panel).toContain("!project || Boolean(goal.trim())");
  });
});

describe("the details panel", () => {
  it("has the four sections, in the order a person asks about them", () => {
    expect([...CHANNEL_DETAILS_SECTIONS]).toEqual(["about", "members", "files", "memory"]);
    expect(CHANNEL_DETAILS_SECTIONS.map((id) => CHANNEL_DETAILS_SECTION_LABELS[id])).toEqual([
      "About",
      "Members",
      "Files",
      "Memory",
    ]);
  });

  it("calls the shared brief Instructions, never a bulletin", () => {
    expect(DETAILS).toMatch(/>\s*Instructions\s*<\/label>/);
    expect(visibleWords(DETAILS).filter((text) => /bulletin/i.test(text))).toEqual([]);
  });

  it("holds the lead and the folder, so About is the whole of how a channel behaves", () => {
    expect(DETAILS).toContain("Who answers");
    expect(DETAILS).toContain(">Folder<");
    expect(DETAILS).toContain("Lead: {member.name}");
  });

  it("lists both kinds of files a channel has", () => {
    expect(DETAILS).toContain("s folder</span>");
    expect(DETAILS).toContain("Each bot&apos;s own files");
    expect(DETAILS).toContain("murage:open-files");
  });

  it("says what is remembered in sentences, and offers Forget and Edit", () => {
    expect(roomMemorySentence("Website launch", 0)).toBe("Nothing is remembered from Website launch yet.");
    expect(roomMemorySentence("Website launch", 1)).toBe("One thing is remembered from Website launch.");
    expect(roomMemorySentence("Website launch", 4)).toBe("4 things are remembered from Website launch.");
    expect(DETAILS).toMatch(/>\s*Forget\s*<\/button>/);
    expect(DETAILS).toMatch(/>\s*Edit\s*<\/button>/);
    expect(DETAILS).toContain('action: "forget"');
    expect(DETAILS).toContain('action: "correct"');
  });

  it("opens and closes the way the members panel does, so there is one contract to learn", () => {
    expect(DETAILS).toContain('role="dialog"');
    expect(DETAILS).toContain('aria-modal="true"');
    expect(DETAILS).toContain("triggerRef.current?.focus()");
    expect(DETAILS).toContain('event.key === "Escape"');
  });

  it("names the thing by what it is", () => {
    expect(channelNoun({ channelProject: undefined })).toBe("channel");
    expect(channelNoun({ channelProject: { goal: "g", status: "active", startedAt: 1, updatedAt: 1 } })).toBe("project");
  });
});

describe("a project's home", () => {
  it("states the goal and the status, and nothing else is the headline", () => {
    expect(PROJECT_HOME).toContain("What this is for");
    expect(PROJECT_HOME).toContain("How it is going");
    expect(PROJECT_HOME).toContain("CHANNEL_PROJECT_STATUS_LABELS[project.status]");
  });

  it("has a plain line under every status word, so the word is never the only clue", () => {
    for (const status of CHANNEL_PROJECT_STATUSES) {
      expect(PROJECT_STATUS_NOTES[status].length).toBeGreaterThan(0);
      expect(CHANNEL_PROJECT_STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
  });

  it("dates the work, and counts nothing", () => {
    const started = Date.UTC(2026, 2, 4, 12);
    const finished = Date.UTC(2026, 4, 9, 12);
    expect(projectTimingLine({ startedAt: started })).toMatch(/^Started .+\.$/);
    expect(projectTimingLine({ startedAt: started, completedAt: finished })).toMatch(/^Started .+\. Finished .+\.$/);
  });

  it("is a second view of the same channel, not a second chat", () => {
    expect(GROUP_VIEW).toContain('tab === "overview" ? "Overview" : "Chat"');
    expect(GROUP_VIEW).toContain('projectTab === "chat"');
    expect(GROUP_VIEW).toContain("<ProjectHome");
  });
});

describe("archiving a channel", () => {
  it("keeps archived channels out of the list", () => {
    expect(SIDEBAR).toContain("state.groups.filter((g) => !g.hidden &&");
  });

  it("gives them a way back, the way archived bots have one", () => {
    expect(SIDEBAR).toContain("Archived channels");
    expect(SIDEBAR).toContain("function ArchivedChannelsPanel(");
    expect(SIDEBAR).toContain("Every message is still here. Restore one and it comes straight back.");
    expect(SIDEBAR).toContain("void restore(group)");
    expect(SIDEBAR).toContain("Restore all");
  });

  it("offers Undo on the toast, so an accident costs one click", () => {
    expect(SIDEBAR).toContain("restoreGroup: { id: group.id, name: group.name }");
    expect(SIDEBAR).toContain("const undoGroupArchive = async");
  });

  it("archives from the row menu too, above the line from Delete", () => {
    const menu = SIDEBAR.slice(SIDEBAR.indexOf("function RoomContextMenu("), SIDEBAR.indexOf("function NewRoomPanel("));
    expect(menu.indexOf("Archive")).toBeLessThan(menu.indexOf("Delete Channel"));
  });
});

describe("one name for each thing", () => {
  it.each(LANE_FILES)("%s never shows the word bulletin", (_name, source) => {
    expect(visibleWords(source).filter((text) => /bulletin/i.test(text))).toEqual([]);
  });

  it.each(LANE_FILES)("%s writes no em dash anywhere a person can read", (_name, source) => {
    expect(visibleWords(source).filter((text) => text.includes("\u2014"))).toEqual([]);
    // A template literal is a sentence too: an aria-label built from one is
    // read out loud, and an em dash in it is the same defect.
    const templates: string[] = [];
    for (const line of source.split("\n")) {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
      if (!code.trim()) continue;
      for (const [, text] of code.matchAll(/`([^`]*)`/g)) templates.push(text);
      for (const [, text] of code.matchAll(/'([^'\\]{2,})'/g)) templates.push(text);
    }
    expect(templates.filter((text) => text.includes("\u2014"))).toEqual([]);
  });

  it.each(LANE_FILES)("%s never sells on price and never shows money", (_name, source) => {
    const money = /\b(cheap|discount|wholesale|affordable|save money|budget|spend|spending|cost|costs|pricing|tokens?)\b|[$£€]\d/i;
    expect(visibleWords(source).filter((text) => money.test(text))).toEqual([]);
  });

  it.each(LANE_FILES)("%s never names the connected-app vendor and never counts models", (_name, source) => {
    expect(visibleWords(source).filter((text) => /composio/i.test(text))).toEqual([]);
    expect(visibleWords(source).filter((text) => /\d+\+?\s*models?\b/i.test(text))).toEqual([]);
  });

  it.each(LANE_FILES)("%s frames nothing as a lesson", (_name, source) => {
    expect(visibleWords(source).filter((text) => /\b(lesson|homework|exercise|quiz|assignment)\b/i.test(text))).toEqual([]);
  });
});

describe("three nouns on the surface", () => {
  it("offers exactly two things to create with bots in them, each explained in one line", () => {
    const menu = SIDEBAR.slice(
      SIDEBAR.indexOf("export function SidebarCreateMenu("),
      SIDEBAR.indexOf("export function sidebarBotVisible("),
    );
    expect(menu).toContain("A chat with some bots.");
    expect(menu).toContain("A piece of work with its own goal, files and chat.");
  });

  it("files unfiled projects under their own heading, leaving filed ones with their team", () => {
    expect(SIDEBAR).toContain('export const PROJECTS_SECTION_ID = "builtin:projects";');
    expect(SIDEBAR).toContain('id === PROJECTS_SECTION_ID ? "Projects"');
    expect(SIDEBAR).toContain("unsectionedRooms.filter((group) => Boolean(group.channelProject))");
  });

  it("keeps memory types, context stacking and approvals off these screens", () => {
    for (const [, source] of LANE_FILES) {
      expect(visibleWords(source).filter((text) => /context stack|memory scope|approval mode/i.test(text))).toEqual([]);
    }
  });
});
