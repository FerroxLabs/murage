// Upstream #1629: the Routines problems pill was a bare count that only
// cleared one run at a time. It now opens this list, which shows exactly the
// runs behind the number and can mark them all read at once.
import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RoutineRun } from "@/lib/routines";
import type { Bot } from "@/state/store";
import { RoutineProblemsList, unseenRoutineProblems } from "./RoutineProblemsList";

const bot = { id: "runner", name: "Runner" } as Bot;
const failed = {
  id: "failed-run", routineId: "broken", routineName: "Broken report", target: "bot", botId: bot.id,
  runOn: "ember", scheduledFor: 200, createdAt: 200, status: "failed", error: "Provider crashed",
} as RoutineRun;
const missed = { ...failed, id: "missed-run", routineId: "stale", routineName: "Stale digest", status: "missed", scheduledFor: 100, error: undefined } as RoutineRun;
const completed = { ...failed, id: "fine-run", routineName: "Fine brief", status: "completed" } as RoutineRun;
const seen = { ...failed, id: "seen-run", routineName: "Old failure", seenAt: 1 } as RoutineRun;
const runs = [missed, completed, seen, failed];

type Props = { onClick?: () => void; "aria-label"?: string; children?: ReactNode };
function buttons(props: Parameters<typeof RoutineProblemsList>[0]) {
  const found = new Map<string, Props>();
  const text = (node: ReactNode): string => typeof node === "string" ? node : Children.toArray(node).map((child) => isValidElement<Props>(child) ? text(child.props.children) : String(child)).join("");
  const visit = (node: ReactNode) => Children.forEach(node, (child) => {
    if (!isValidElement<Props>(child)) return;
    if (child.type === "button") found.set(child.props["aria-label"] ?? text(child.props.children), child.props);
    visit(child.props.children);
  });
  function Capture() { visit(RoutineProblemsList(props)); return null; }
  renderToStaticMarkup(createElement(Capture));
  return found;
}

describe("routine problems", () => {
  it("counts only unseen failed and missed runs, newest first", () => {
    expect(unseenRoutineProblems(runs).map((run) => run.id)).toEqual(["failed-run", "missed-run"]);
  });

  it("lists exactly those runs", () => {
    const html = renderToStaticMarkup(createElement(RoutineProblemsList, { runs, bots: [bot], onClose: vi.fn(), onOpen: vi.fn(), onMarkAllSeen: vi.fn() }));
    expect(html).toContain("Broken report");
    expect(html).toContain("Stale digest");
    expect(html).toContain("Provider crashed");
    expect(html).not.toContain("Fine brief");
    expect(html).not.toContain("Old failure");
  });

  it("marks them all read in one action, and opens one on click", () => {
    const onMarkAllSeen = vi.fn(), onOpen = vi.fn();
    const found = buttons({ runs, bots: [bot], onClose: vi.fn(), onOpen, onMarkAllSeen });
    found.get("Mark all as read")!.onClick!();
    expect(onMarkAllSeen).toHaveBeenCalledOnce();
    found.get("Open Stale digest run")!.onClick!();
    expect(onOpen).toHaveBeenCalledWith(missed);
  });

  it("offers no bulk action when nothing is left", () => {
    const found = buttons({ runs: [completed, seen], bots: [bot], onClose: vi.fn(), onOpen: vi.fn(), onMarkAllSeen: vi.fn() });
    expect(found.has("Mark all as read")).toBe(false);
  });
});
