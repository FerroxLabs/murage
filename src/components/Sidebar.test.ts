import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// posthog-js boots on import and reaches for a real browser. Nothing under
// test here reports anything, so the module is stubbed rather than shimmed.
vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false,
  optAction: () => "none" as const,
  setAnalyticsEnabled: () => {},
  initAnalytics: () => {},
  track: () => {},
  identifyEmail: () => {},
  emailGateDone: () => false,
  setEmailGateDone: () => {},
}));

// Sidebar's import graph reads `window` at module scope (DesktopCapabilities
// asks the desktop shell what it is running on), and this suite runs in node.
// A bare object is the honest answer: no shell, browser capabilities.
(globalThis as unknown as { window?: unknown }).window ??= {};
const { TeamFeedbackToast, teamImportFeedback, teamImportShortfall, teamUndoRestores, sidebarBotVisible, sidebarBotPreview, sidebarGroupPreview,
  archivedBotDeleteDetail, archivedBotsDeleteDetail, archivedBotsDeleteItems, archivedBotsDeletePhrase, SidebarRowMark, sidebarThreadOwed, sidebarSnoozedUntil } =
  await import("./Sidebar");
import type {
  ArchivedTeamBot,
  TeamImportResult,
  TeamImportSkillError,
} from "./TeamLibraryPanel";
import { botRole } from "@/lib/bot-role";
import type { Bot, Group, Message } from "@/state/store";

describe("plain-text sidebar message previews", () => {
  const message = (text: string, extra: Partial<Message> = {}): Message => ({
    id: "preview-message", role: "bot", kind: "text", text, at: 1, ...extra,
  } as Message);
  const bot = (messages: Message[], extra: Partial<Bot> = {}): Bot => ({
    id: "preview-bot", name: "Kessler", messages, ...extra,
  } as Bot);

  it("strips message Markdown without modifying the transcript", () => {
    const original = message("**Kessler secured** the `report` and [sources](https://example.com).\n- Ready for review");
    const before = JSON.stringify(original);
    expect(sidebarBotPreview(bot([original]))).toBe("Kessler secured the report and sources. Ready for review");
    expect(JSON.stringify(original)).toBe(before);
  });

  it("flattens setup-card titles too", () => {
    expect(sidebarBotPreview(bot([message("", { kind: "options", card: { title: "## **Choose** a setup", subtitle: "", options: [] } })])))
      .toBe("Choose a setup");
  });

  it("preserves status labels and ordinary punctuation", () => {
    const messages = [message("**Ready**")];
    expect(sidebarBotPreview(bot(messages, { busy: true }))).toBe("Working…");
    expect(sidebarBotPreview(bot(messages, { busy: true, activity: "waiting-on-you" }))).toBe("Waiting for you…");
    expect(sidebarBotPreview(bot([message("2 * 3 * 4 and snake_case")]))).toBe("2 * 3 * 4 and snake_case");
    expect(sidebarBotPreview(bot([]))).toBe("");
  });

  it("uses the selected conversation branch, not the last stored fork", () => {
    const messages = [message("**Root**", { id: "root" }), message("**Selected**", { id: "selected", parentId: "root" }), message("**Other fork**", { id: "other", parentId: "root" })];
    expect(sidebarBotPreview(bot(messages, { activeLeafId: "selected" }))).toBe("Selected");
  });

  it("strips team message Markdown while preserving the sender label", () => {
    const original = message("**Ready** with [notes](https://example.com)", { from: { botId: "preview-bot", name: "Kessler", color: "blue" } });
    const group = { messages: [original], memberIds: ["preview-bot"] } as Group;
    expect(sidebarGroupPreview(group, [])).toBe("Kessler: Ready with notes");
    expect(original.text).toBe("**Ready** with [notes](https://example.com)");
    expect(sidebarGroupPreview({ ...group, messages: [message("__Reviewed__", { role: "user" })] }, [])).toBe("You: Reviewed");
  });
});

describe("presentation-only sidebar hiding", () => {
  it("restores visibility without admitting archived bots", () => {
    expect(sidebarBotVisible({}, false)).toBe(true);
    expect(sidebarBotVisible({ sidebarHidden: true }, false)).toBe(false);
    expect(sidebarBotVisible({ sidebarHidden: true }, true)).toBe(true);
    expect(sidebarBotVisible({ sidebarHidden: true, hidden: true }, true)).toBe(false);
  });
});

/** The chair a bot lands in when the undo's PATCH is applied.
 *
 *  Asserted through `botRole` rather than against field names on purpose:
 *  the org chart is three fields read together, and the bug this guards was
 *  a body that looked right field by field and still put the workspace
 *  Chief one rung down. The only question worth asking a restore body is
 *  what chair it produces. */
const chairAfterUndo = (archived: ArchivedTeamBot) => {
  const [restore] = teamUndoRestores([archived]);
  return botRole({
    chiefOfStaff: restore.body.chiefOfStaff === true,
    chiefScope: restore.body.chiefScope === "workspace" ? "workspace" : undefined,
  });
};

const chief: ArchivedTeamBot = { id: "chief", chiefOfStaff: true, chiefTier: "workspace" };
const lead: ArchivedTeamBot = { id: "lead", chiefOfStaff: true, chiefTier: "section" };
const plain: ArchivedTeamBot = { id: "plain", chiefOfStaff: false, chiefTier: null };

describe("undoing a team import puts the old roster back in its own chairs", () => {
  it("returns the workspace Chief to the workspace chair", () => {
    expect(chairAfterUndo(chief)).toBe("chief");
  });

  it("returns a section lead as a section lead, not as the Chief", () => {
    // The opposite mistake to the one that started this. A restore that
    // reached for the workspace tier on every leader would seat the wrong
    // bot at the top and trip the harness's single-holder guard on the way.
    expect(chairAfterUndo(lead)).toBe("leader");
  });

  it("returns a bot that led nothing leading nothing", () => {
    expect(chairAfterUndo(plain)).toBe("member");
  });

  it("leaves no archived bot behind, whatever chair it held", () => {
    // The demotion arrived inside a branch split: chiefs down one path,
    // everyone else down another. One map over the whole archive is what
    // makes a second, divergent path impossible.
    const restores = teamUndoRestores([chief, lead, plain]);
    expect(restores.map((restore) => restore.id)).toEqual(["chief", "lead", "plain"]);
  });

  it("un-hides every one of them", () => {
    for (const restore of teamUndoRestores([chief, lead, plain])) {
      expect(restore.body.hidden).toBe(false);
    }
  });

  it("asks for nothing at all when nothing was archived", () => {
    // WEAKER THAN IT LOOKS: an empty archive maps to an empty list under any
    // implementation of this function, so no realistic mistake turns this
    // one red. Kept because an additive import must send no PATCH at all,
    // and that fact is worth stating even where a test cannot defend it.
    expect(teamUndoRestores([])).toEqual([]);
  });
});

const failure = (
  stage: TeamImportSkillError["stage"],
  skillId: string,
  botName = "Clerk",
): TeamImportSkillError => ({ botId: botName, botName, skillId, stage, error: "nope" });

const imported = (skillErrors: TeamImportSkillError[], archived: ArchivedTeamBot[] = []): TeamImportResult => ({
  name: "Ops crew",
  members: 3,
  importedBotIds: ["a", "b", "c"],
  importedGroupIds: [],
  importedRoutineIds: [],
  archived,
  skillErrors,
});

describe("a team that landed short of the skills it promised says so", () => {
  it("says nothing when the import was whole", () => {
    expect(teamImportShortfall({ skillErrors: [] })).toBe("");
  });

  it("speaks up when a skill did not make it", () => {
    expect(teamImportShortfall({ skillErrors: [failure("install", "web-search")] })).not.toBe("");
  });

  it("counts what is missing", () => {
    const detail = teamImportShortfall({
      skillErrors: [failure("install", "a"), failure("install", "b")],
    });
    expect(detail).toContain("2");
  });

  it("tells a skill that never arrived apart from one that arrived switched off", () => {
    // Two different things to go and fix. A summary that folds them into one
    // number sends somebody looking in the wrong place.
    const neverArrived = teamImportShortfall({ skillErrors: [failure("install", "a")] });
    const switchedOff = teamImportShortfall({ skillErrors: [failure("enable", "a")] });
    expect(switchedOff).not.toBe(neverArrived);
  });

  it("names the one bot that is short, and stops naming them past that", () => {
    const one = teamImportShortfall({ skillErrors: [failure("install", "a", "Clerk")] });
    expect(one).toContain("Clerk");
    const many = teamImportShortfall({
      skillErrors: [
        failure("install", "a", "Clerk"),
        failure("install", "b", "Scout"),
        failure("enable", "c", "Runner"),
      ],
    });
    expect(many).not.toContain("Clerk");
    expect(many).toContain("3");
  });

  it("never quotes a total it was not given", () => {
    // The response carries the failures, not the number of skills the
    // profile declared. "7 of 9" would be invented.
    const detail = teamImportShortfall({ skillErrors: [failure("install", "a"), failure("enable", "b")] });
    expect(detail).not.toMatch(/\bof\s+\d/);
  });

  it("carries no em dash", () => {
    expect(teamImportShortfall({ skillErrors: [failure("install", "a"), failure("enable", "b")] })).not.toMatch(
      /[–—]/,
    );
  });
});

describe("the toast a finished import puts up", () => {
  it("is not an error, even when skills were lost", () => {
    // The bots landed and the rooms landed. A red toast over a working team
    // would be wrong in the other direction, and would teach people to
    // dismiss the one that matters.
    expect(teamImportFeedback(imported([failure("install", "a")])).error).toBe(false);
  });

  it("carries the shortfall as a second line rather than in the headline", () => {
    const feedback = teamImportFeedback(imported([failure("install", "a")]));
    expect(feedback.detail).toBe(teamImportShortfall({ skillErrors: [failure("install", "a")] }));
    // Guarded, because `not.toContain("")` would report a missing detail as a
    // headline problem and send the next reader to the wrong place.
    expect(feedback.detail).not.toBe("");
    expect(feedback.text).not.toContain(feedback.detail);
  });

  it("says nothing extra about a whole import", () => {
    expect(teamImportFeedback(imported([])).detail).toBe("");
  });

  it("offers Undo only when there is a previous roster to put back", () => {
    expect(teamImportFeedback(imported([])).undo).toBeUndefined();
    expect(teamImportFeedback(imported([], [chief])).undo).toBeDefined();
  });

  it("renders the shortfall where a person will read it", () => {
    const feedback = teamImportFeedback(imported([failure("install", "a"), failure("enable", "b")]));
    const markup = renderToStaticMarkup(
      createElement(TeamFeedbackToast, { feedback, onUndoTeam: () => {}, onUndoBot: () => {} }),
    );
    expect(feedback.detail).not.toBe("");
    expect(markup).toContain(feedback.detail);
  });

  it("renders no second line at all when there is nothing to add", () => {
    const markup = renderToStaticMarkup(
      createElement(TeamFeedbackToast, {
        feedback: teamImportFeedback(imported([])),
        onUndoTeam: () => {},
        onUndoBot: () => {},
      }),
    );
    expect(markup).not.toContain("<p");
  });

  it("does not dress a short import in the error styling", () => {
    const markup = renderToStaticMarkup(
      createElement(TeamFeedbackToast, {
        feedback: teamImportFeedback(imported([failure("install", "a")])),
        onUndoTeam: () => {},
        onUndoBot: () => {},
      }),
    );
    expect(markup).not.toContain("text-danger");
  });
});

describe("what the archived-bot delete confirmation says", () => {
  const bot = (id: string, name: string, extra: Partial<Bot> = {}): Bot =>
    ({ id, name, title: "", hidden: true, messages: [], ...extra }) as Bot;
  const group = (id: string, name: string, memberIds: string[], extra: Partial<Group> = {}): Group =>
    ({ id, name, memberIds, messages: [], ...extra }) as Group;
  const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ threadId: `t${i}` })) as Bot["tasks"];

  it("counts the conversations that go and names the channels that stay", () => {
    const kessler = bot("k", "Kessler", { tasks: tasks(3) });
    const detail = archivedBotDeleteDetail(kessler, [
      group("g1", "Launch", ["k", "other"]),
      group("g2", "Ops", ["other"]),
      group("dm", "Kessler & Aria", ["k", "a"], { dm: true }),
    ]);
    expect(detail).toContain("Permanently deletes Kessler: 3 conversations with it");
    expect(detail).toContain("There is no undo and nothing to restore from.");
    expect(detail).toContain("Kept: the channel it was in (Launch), with every message it said there.");
    expect(detail).not.toContain("Ops");
    expect(detail).not.toContain("Kessler & Aria");
  });

  it("says so plainly when the bot was in no channel, and counts one conversation for a bot with no task list", () => {
    const detail = archivedBotDeleteDetail(bot("k", "Kessler"), [group("g2", "Ops", ["other"])]);
    expect(detail).toContain("1 conversation with it");
    expect(detail).toContain("It was in no channels, so nothing else changes.");
    expect(detail).not.toContain("Kept:");
  });

  it("pluralises the channels that are kept", () => {
    const detail = archivedBotDeleteDetail(bot("k", "Kessler"), [group("g1", "Launch", ["k"]), group("g2", "Ops", ["k"])]);
    expect(detail).toContain("Kept: the 2 channels it was in (Launch, Ops)");
  });

  it("totals the bulk delete and lists every bot by name with its conversation count", () => {
    const bots = [bot("a", "Aria", { tasks: tasks(2), title: "Researcher" }), bot("b", "Bram"), bot("c", "Cass", { tasks: tasks(5) })];
    const groups = [group("g1", "Launch", ["a", "b"]), group("g2", "Ops", ["c"]), group("dm", "dm", ["a", "b"], { dm: true })];
    const detail = archivedBotsDeleteDetail(bots, groups);
    expect(detail).toContain("Permanently deletes these 3 archived bots and their 8 conversations");
    expect(detail).toContain("Kept: all 2 channels they were in, with every message said there.");
    expect(detail).toContain("is left alone and named afterwards");
    expect(archivedBotsDeleteItems(bots)).toEqual([
      "Aria (Researcher): 2 conversations",
      "Bram: 1 conversation",
      "Cass: 5 conversations",
    ]);
    expect(archivedBotsDeletePhrase(3)).toBe("delete 3 bots");
  });

  it("says nothing else changes when none of the bulk set sat in a channel", () => {
    expect(archivedBotsDeleteDetail([bot("a", "Aria"), bot("b", "Bram")], [group("g2", "Ops", ["other"])]))
      .toContain("None of them was in a channel, so nothing else changes.");
  });

  it("never promises an undo or a backup, and carries no em dash", () => {
    const bots = [bot("a", "Aria"), bot("b", "Bram")];
    for (const text of [archivedBotDeleteDetail(bots[0]!, []), archivedBotsDeleteDetail(bots, []), ...archivedBotsDeleteItems(bots)]) {
      expect(text).not.toMatch(/undo (is|will be) available|restore (it|them) later|backup/i);
      expect(text).not.toContain(String.fromCodePoint(0x2014));
    }
  });
});

// Customer journey, screen reader pass: the bot row's "More actions" button
// announced a menu (aria-haspopup="menu") that was a plain stack of buttons,
// New Channel was an unnamed popup, and a channel row read its members'
// avatar names run into its own ("Pearl Ember Launch team").
describe("sidebar menus, dialogs and rows say what they are", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
  const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

  it("opens a real menu of menu items from More actions", () => {
    const menu = between("export function BotContextMenu", "function BotListItem");
    expect(menu).toMatch(/data-bot-menu\s+role="menu"/);
    expect(menu).toContain("aria-label={`Actions for ${bot.name}`}");
    expect(menu).toMatch(/<button\s+key=\{label\}\s+role="menuitem"/);
    expect(menu).toContain('role="separator"');
    // arrow keys move between items and Escape closes, as a menu promises
    expect(menu).toMatch(/ArrowDown/);
    expect(menu).toMatch(/Escape/);
  });

  it("names the New Channel popup as a dialog, and its name field", () => {
    const panel = between("function NewRoomPanel", "/** Move-to-section popover");
    expect(panel).toMatch(/role="dialog"\s+aria-modal="true"\s+aria-labelledby="new-channel-title"/);
    expect(panel).toContain('id="new-channel-title"');
    // One panel makes both, so the name field is labelled for whichever is
    // being made. Both labels have to exist, and neither may be a template.
    expect(panel).toContain('"Channel name"');
    expect(panel).toContain('"Project name"');
  });

  it("offers Channel and Project as two named choices, each saying what it is", () => {
    const menu = between("export function SidebarCreateMenu", "export function sidebarBotVisible");
    expect(menu).toContain("New Channel");
    expect(menu).toContain("A chat with some bots.");
    expect(menu).toContain("New Project");
    expect(menu).toContain("A piece of work with its own goal, files and chat.");
  });

  it("gives a channel row a More-actions control that a touch screen can reach", () => {
    const row = between("function GroupListItem", "function RoomContextMenu");
    // A touch device fires no `contextmenu` event and has no Shift+F10, so
    // a visible control is the only way into the menu there.
    expect(row).toContain("aria-haspopup=\"menu\"");
    expect(row).toContain("More actions for ${group.name}");
    expect(row).toContain("[@media(hover:none)]:opacity-100");
  });

  it("keeps member avatars out of a channel row's name", () => {
    const stacked = between("function StackedEmbers", "function GroupListItem");
    expect(stacked.match(/aria-hidden="true"/g)?.length).toBe(2);
  });
});

describe("a dot in the sidebar means one thing", () => {
  const html = (mark: Parameters<typeof SidebarRowMark>[0]["mark"]) =>
    renderToStaticMarkup(createElement(SidebarRowMark, { mark }));

  it("draws an amber dot for one thing waiting, and a count for more", () => {
    const one = html({ kind: "waiting", count: 1 });
    expect(one).toContain('data-sidebar-mark="waiting"');
    expect(one).toContain("bg-warning");
    // One thing waiting is a dot, not the number 1.
    expect(one).not.toContain(">1<");

    const many = html({ kind: "waiting", count: 4 });
    expect(many).toContain("4");
    expect(many).toContain("text-warning");
  });

  it("turns a ring for working, with no dot and no number", () => {
    const working = html({ kind: "working" });
    expect(working).toContain('data-sidebar-mark="working"');
    expect(working).toContain("animate-spin");
    // Motion, not colour: nothing here is amber, accent or success.
    expect(working).not.toContain("bg-warning");
    expect(working).not.toContain("bg-accent");
    expect(working).not.toContain("bg-success");
    // and it never carries a count: working resolves by itself.
    expect(working).not.toMatch(/>\s*\d+\s*</);
  });

  it("draws nothing at all for unread, and nothing for nothing", () => {
    expect(html({ kind: "unread" })).toBe("");
    expect(html({ kind: "none" })).toBe("");
  });
});

// WHAT IS NOT PROVEN HERE, SAID OUT LOUD.
//
// Four checks stood here and read `Sidebar.tsx` AS TEXT, asserting that
// `BotListItem` contained `const mark = sidebarBotMark(bot);` and no longer
// contained `rounded-full bg-accent"`. One of them pinned the shape of an
// `aria-label` expression with a regex over source whitespace.
//
// They are deleted, and `816c3377` earlier on this same branch is why: it
// removed seven tests of exactly this shape from `server/index.ts` with the
// reason that they "go green on a call sitting in dead code and red on a
// reformat that changes nothing, which is the wrong way round in both
// directions". Re-adding four of them the same day would be re-adding a
// defect somebody had already argued out.
//
// So this is the honest state. PROVEN, by rendering: `SidebarRowMark` draws
// an amber dot with a count for waiting, a ring with no number for working,
// and nothing at all for unread or for nothing (above); and a collapsed
// section badges waiting alone (SidebarSectionHeader.test.ts). PROVEN, as
// pure functions: the whole mark ladder, the waiting count, the accessible
// label, the name weight and the row tint (sidebar-attention.test.ts).
//
// NOT PROVEN ANYWHERE IN VITEST: that `BotListItem` and `GroupListItem`
// actually mount that component and spend those classes. Both are unexported
// and need the store provider, so this suite cannot render them. That wiring
// is covered only by the first-run human specs, which drive the real
// renderer — and if it is ever worth pinning properly, the way is to render
// the row, not to read the file that draws it.

describe("snoozing from a sidebar row", () => {
  const bots = [{ id: "b", threadId: "open", activity: "waiting-on-you",
    tasks: [{ threadId: "open", activity: "idle" }, { threadId: "asking", activity: "waiting-on-you" }] }] as unknown as Bot[];
  it("will not snooze a conversation that is waiting on the owner", () => {
    expect(sidebarThreadOwed("asking", bots, {})).toBe(true);
    expect(sidebarThreadOwed("open", bots, {})).toBe(false);
    expect(sidebarThreadOwed("open", bots, { open: 1 })).toBe(true);
    expect(sidebarThreadOwed("room", bots, {})).toBe(false);
  });
  it("only reports a snooze that is still ahead", () => {
    const snoozes = new Map([["open", 2_000]]);
    expect(sidebarSnoozedUntil("open", snoozes, 1_000)).toBe(2_000);
    expect(sidebarSnoozedUntil("open", snoozes, 2_000)).toBeUndefined();
  });
  it("offers Snooze in both row menus only when the desktop passes a handler", () => {
    const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
    expect(source).toContain('...(snoozable && onSnooze ? [item(');
    expect(source.match(/snoozable=\{desktop === true\}/g)).toHaveLength(2);
  });
});
