// UX L5B: the routine sheet's controls (static markup over a fixed store), and
// the sentence sheet's helpers: who gets the routine, its name, and that the
// Ask path only fills the chat draft (it never sends).
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Routine, RoutineRun } from "@/lib/routines";

const at = (day: number, hour: number) => new Date(2026, 10, 5 + day, hour).getTime();
const max = { id: "max", name: "Max", threadId: "t-max", autoApprove: true, fullAccess: false, role: "chief" };
const nova = { id: "nova", name: "Nova", threadId: "t-nova", autoApprove: false, fullAccess: false };
const theRoutine: Routine = {
  id: "r1", name: "Morning brief", prompt: "Send me a brief", target: "bot", botId: "max", runOn: "ember", enabled: true,
  schedule: { type: "daily", time: "08:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, nextRunAt: null, createdAt: 0, updatedAt: 0,
};
const runs: RoutineRun[] = [
  { id: "run-a", routineId: "r1", routineName: "Morning brief", target: "bot", botId: "max", runOn: "ember", scheduledFor: at(-1, 8), status: "failed", manual: false, createdAt: 0 },
];

vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { bots: [max, nova], groups: [], routines: [theRoutine], routineRuns: runs }, dispatch: vi.fn() }),
}));
vi.mock("@/hooks/use-modal-dialog", () => ({ useModalDialog: () => undefined }));
vi.mock("@/components/Avatar", () => ({ BotAvatar: () => null }));
vi.mock("@/lib/bot-role", () => ({ botRole: (bot: { role?: string }) => bot.role ?? "member" }));

const { RoutineSheet, RoutineListSheet } = await import("./RoutineSheet");
const { NewRoutineSheet, routeSentenceToChat, sentenceRoutineBot, sentenceRoutineName } = await import("./NewRoutineSheet");

function sheet(canEdit: boolean): string {
  return renderToStaticMarkup(createElement(RoutineSheet, { routine: theRoutine, canEdit, onClose: () => {}, onEdit: () => {}, onOpenRun: () => {} }));
}

describe("RoutineSheet", () => {
  it("shows Who, When, Level, Reports to and Last runs, with Run now as the primary on the right", () => {
    const html = sheet(true);
    for (const word of ["Who", "When", "Level", "Reports to", "Last runs", "Follows Max&#x27;s level (Auto)", "Max&#x27;s chat", "Needs a look"]) expect(html).toContain(word);
    const order = ["Delete", "Edit", "Pause", "Run now"].map((word) => html.lastIndexOf(`>${word}<`));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("run marks are buttons that name their run", () => {
    const html = sheet(true);
    expect(html).toMatch(/<button[^>]*data-routine-run-mark="run-a"[^>]*aria-label="Open the run from [^"]+"/);
  });

  it("away from the desktop app: Run now only, and it says where to change it", () => {
    const html = sheet(false);
    expect(html).toContain("Run now");
    expect(html).not.toContain(">Delete<");
    expect(html).not.toContain(">Pause<");
    expect(html).toContain("in the desktop app");
  });

  it("L5B-SHEET-DETAILS: away from the desktop app the sheet still shows the instructions, files, run limit and health", () => {
    const detailed: Routine = {
      ...theRoutine,
      prompt: "Read the inbox and send me three lines.",
      attachments: [{ id: "a1", kind: "file", name: "brief.pdf", path: "/home/owner/brief.pdf", size: 10 }],
      timeoutMinutes: 30,
      failureStreak: 1,
    };
    for (const canEdit of [false, true]) {
      const html = renderToStaticMarkup(createElement(RoutineSheet, { routine: detailed, canEdit, onClose: () => {}, onEdit: () => {}, onOpenRun: () => {} }));
      for (const word of ["Instructions", "Read the inbox and send me three lines.", "Files", "brief.pdf", "Run limit", "Stops if still running after 30 min", "The last run failed."]) expect(html).toContain(word);
      // The file's path never reaches the page.
      expect(html).not.toContain("/home/owner/brief.pdf");
    }
  });

  it("a connected-app routine has no Run now, Edit or Change: the server refuses them (Astra r1 Medium 8)", () => {
    const appRoutine: Routine = { ...theRoutine, schedule: { type: "app_event", triggerId: "x" } };
    const html = renderToStaticMarkup(createElement(RoutineSheet, { routine: appRoutine, canEdit: true, onClose: () => {}, onEdit: () => {}, onOpenRun: () => {} }));
    expect(html).not.toContain(">Run now<");
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain(">Change<");
    expect(html).toContain(">Pause<");
  });

  it("the All routines list opens each routine from a button row", () => {
    const html = renderToStaticMarkup(createElement(RoutineListSheet, { onClose: () => {}, onOpen: () => {}, onNew: () => {}, canCreate: true }));
    expect(html).toMatch(/<button[^>]*data-routine-row="r1"/);
    expect(html).toContain("New routine");
  });
});

describe("New routine from a sentence", () => {
  it("asks the Chief to set it up as the primary; no time is read from the words, so there is no Start", () => {
    const html = renderToStaticMarkup(createElement(NewRoutineSheet, { onClose: () => {}, onChange: () => {}, onAskInChat: () => {} }));
    expect(html).toContain("Ask Max to set it up");
    expect(html).toContain(">Pick a time<");
    expect(html).not.toMatch(/>Start /);
    expect(html).not.toContain("data-sentence-when");
    expect(html.indexOf(">Pick a time<")).toBeLessThan(html.indexOf("Ask Max to set it up"));
  });
  it("goes to the chat the owner came from, else the Chief, else the first bot", () => {
    const list = [nova, max] as never[];
    expect(sentenceRoutineBot(list, "nova")?.id).toBe("nova");
    expect(sentenceRoutineBot(list)?.id).toBe("max");
    expect(sentenceRoutineBot([nova] as never[])?.id).toBe("nova");
    expect(sentenceRoutineBot([])).toBeUndefined();
  });

  it("names the routine from the task, cut at a word", () => {
    expect(sentenceRoutineName("Send me a brief")).toBe("Send me a brief");
    const long = sentenceRoutineName("Read every unread email from the last day and write me a short summary of what matters most");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith(" ")).toBe(false);
  });

  it("Ask puts the sentence in the bot's chat draft and focuses it; typed words stay; nothing sends", () => {
    const drafts = new Map<string, string>();
    const focus = vi.fn();
    const io = { readDraft: (id: string) => drafts.get(id) ?? "", setDraft: (id: string, text: string) => void drafts.set(id, text), focus };
    routeSentenceToChat(max, "every weekday at 8, send me a brief", io);
    expect(drafts.get("bot:max:t-max")).toBe("every weekday at 8, send me a brief");
    expect(focus).toHaveBeenCalledWith("max");
    drafts.set("bot:nova:t-nova", "hello");
    routeSentenceToChat(nova, "tomorrow at 9 call the bank", io);
    expect(drafts.get("bot:nova:t-nova")).toBe("hello\n\ntomorrow at 9 call the bank");
    routeSentenceToChat(nova, "tomorrow at 9 call the bank", io);
    expect(drafts.get("bot:nova:t-nova")).toBe("hello\n\ntomorrow at 9 call the bank");
  });
});

describe("New routine editor", () => {
  it("the instructions sit right under the title, above the time and the bot, so they show without scrolling", () => {
    const source = readFileSync(new URL("../RoutineCalendarPage.tsx", import.meta.url), "utf8");
    const editor = source.slice(source.indexOf("function EventEditor("));
    const title = editor.indexOf("placeholder={kind === \"routine\" ? \"Add title\"");
    const instructions = editor.indexOf("<textarea value={description}");
    const time = editor.indexOf('aria-label="Start time"');
    const bot = editor.indexOf("Assign a bot");
    expect(title).toBeGreaterThan(0);
    expect(instructions).toBeGreaterThan(title);
    expect(instructions).toBeLessThan(time);
    expect(instructions).toBeLessThan(bot);
  });
});
