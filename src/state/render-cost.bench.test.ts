// Lane E renderer cost, skipped unless LANE_E_BENCH=1. Prints one BENCH line:
// the per-dispatch work the sidebar and the transcript rows do over held
// messages, the old way (inline copies of the removed code) and the new way.
import { describe, it, vi } from "vitest";

vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false, optAction: () => "none" as const, setAnalyticsEnabled: () => {}, initAnalytics: () => {},
  track: () => {}, identifyEmail: () => {}, emailGateDone: () => false, setEmailGateDone: () => {},
}));
(globalThis as unknown as { window?: unknown }).window ??= {};
const { sidebarBotPreview } = await import("@/components/Sidebar");
import { messageVersions, visibleMessages, type Bot, type Message } from "./store";

const oldVisible = (bot: Bot): Message[] => {
  const byId = new Map(bot.messages.map((m) => [m.id, m]));
  const path: Message[] = [];
  for (let cur = bot.activeLeafId ? byId.get(bot.activeLeafId) : undefined; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) path.push(cur);
  return path.reverse();
};
const oldVersions = (bot: Bot, message: Message) =>
  bot.messages.filter((m) => m.role === "user" && m.kind === "text" && (m.parentId ?? null) === (message.parentId ?? null)).sort((a, b) => a.at - b.at);
const time = (fn: () => void, reps: number) => { const t = performance.now(); for (let i = 0; i < reps; i++) fn(); return Math.round(((performance.now() - t) / reps) * 1000) / 1000; };

describe.skipIf(!process.env.LANE_E_BENCH)("lane E renderer bench", () => {
  it("measures", () => {
    const HELD = 500, BOTS = 60;
    const make = (id: string): Bot => {
      const messages: Message[] = [];
      for (let i = 0; i < HELD; i++) messages.push({ id: `${id}-${i}`, at: i, role: i % 2 ? "bot" : "user", kind: "text", text: `message ${i}`, parentId: i ? `${id}-${i - 1}` : null } as Message);
      return { id, name: id, threadId: `t-${id}`, messages, activeLeafId: `${id}-${HELD - 1}` } as unknown as Bot;
    };
    const bots = Array.from({ length: BOTS }, (_, i) => make(`b${i}`));
    const streaming = bots[0]!;
    // one store dispatch: every sidebar row derives its visible branch and preview
    const sidebarOld = () => { for (const bot of bots) { oldVisible(bot); oldVisible(bot).at(-1); } };
    const sidebarNew = () => { for (const bot of bots) sidebarBotPreview({ ...bot }); };
    sidebarNew();
    // one 30 Hz stream frame: every transcript row asks for its versions
    const rowsOld = () => { for (const m of streaming.messages) if (m.role === "user") oldVersions(streaming, m); };
    const rowsNew = () => { for (const m of streaming.messages) if (m.role === "user") messageVersions(streaming, m); };
    rowsNew(); visibleMessages(streaming);
    console.log("BENCH " + JSON.stringify({
      held: HELD, bots: BOTS,
      sidebarPerDispatchMs: { old: time(sidebarOld, 20), new: time(sidebarNew, 20) },
      transcriptRowsPerFrameMs: { old: time(rowsOld, 20), new: time(rowsNew, 20) },
    }));
  });
});
