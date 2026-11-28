// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount } from "../testing/dom-harness";
import type { Bot, Group } from "@/state/store";
import type { Routine, RoutineRun } from "@/lib/routines";

const fixture = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => fixture, api: fixture.api }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));
vi.mock("@/components/CalendarLayer", () => ({ useCalendarLayer: () => null }));
vi.mock("@/components/LayerSurface", () => ({ LayerSurface: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/Avatar", () => ({ BotAvatar: () => null }));
vi.mock("@/lib/analytics", () => ({ track: () => {}, analyticsEnabled: () => false }));

const { EventEditor, EventDetails } = await import("./RoutineCalendarPage");
const bot = { id: "lead", name: "Lead", color: "blue", tasks: [], modelSelection: { instanceId: "fixture", model: "fixture" } } as unknown as Bot;
const room = (id: string) => ({ id, name: id, memberIds: [bot.id], messages: [] }) as unknown as Group;
const routine: Routine = {
  id: "goal", name: "Daily review", prompt: "Review the notes", target: "room-goal", groupId: "original-room",
  botId: bot.id, runOn: "ember", enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [1] },
  durationMinutes: 30, nextRunAt: null, createdAt: 0, updatedAt: 0,
};
const run: RoutineRun = {
  id: "past-run", routineId: routine.id, routineName: routine.name, target: "room-goal", groupId: "original-room",
  botId: bot.id, runOn: "ember", scheduledFor: 1, status: "completed", manual: false, createdAt: 1,
  executionThreadId: "original-execution",
};
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  fixture.state = { bots: [bot], groups: [room("original-room"), room("new-room")], instances: [], routines: [routine], routineRuns: [run], config: {} };
  fixture.dispatch.mockClear();
  fixture.api.mockClear();
});
afterEach(cleanup);

function editor() {
  return h(EventEditor, {
    lifecycle: {} as never, seed: { kind: "routine", at: Date.now() + 60_000, durationMinutes: 30, botIds: [bot.id], routine },
    bots: [bot], onClose: vi.fn(), onSavedCall: vi.fn(),
  });
}
const saveButton = (container: HTMLElement) => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Save")!;

it("keeps a valid room goal editable, then prevents saving when its room disappears", () => {
  const view = mount(editor());
  expect(saveButton(view.container).disabled).toBe(false);
  fixture.state.groups = [room("new-room")];
  view.rerender(editor());
  expect(saveButton(view.container).disabled).toBe(true);
  act(() => saveButton(view.container).click());
  expect(fixture.api).not.toHaveBeenCalled();
});

it.each(["retargeted", "deleted"])("opens a past run's own room after its routine is %s", (change) => {
  const onOpenRoom = vi.fn();
  const view = mount(h(EventDetails, {
    lifecycle: {} as never,
    item: { kind: "routine", id: run.id, at: run.scheduledFor, durationMinutes: 30, run,
      routine: change === "retargeted" ? { ...routine, target: "bot", groupId: "new-room" } : null },
    bots: [bot], onClose: vi.fn(), onEdit: vi.fn(), onCallChanged: vi.fn(), onOpenRoom,
  }));
  expect(view.container.textContent).toContain("original-room");
  const open = Array.from(view.container.querySelectorAll("button")).find(button => button.textContent === "Open channel task")!;
  expect(open).toBeDefined();
  act(() => open.click());
  expect(onOpenRoom).toHaveBeenCalledExactlyOnceWith("original-room");
  expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchGroupTask", groupId: "original-room", threadId: "original-execution" });
});
