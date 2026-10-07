// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectStripDetails } from "./ProjectStripDetails";
import { projectClient } from "@/lib/use-project";
import { projectEvents } from "@/lib/project-events";
import type { ProjectBoardRead, ProjectResult, ProjectRead } from "@/lib/project-client";

const effects = vi.hoisted(() => [] as EffectCallback[]);
const hooks = vi.hoisted(() => ({ callbacks: [] as Array<() => Promise<void>>, setters: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useCallback: (callback: () => Promise<void>) => { hooks.callbacks.push(callback); return callback; },
  useState: (initial: unknown) => { const setter = vi.fn(); hooks.setters.push(setter); return [initial, setter]; },
  useEffect: (effect: EffectCallback) => { effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: { groups: [], bots: [] } }) }));

const project: ProjectRead = {
  lifecycle: "open", settings: { groupId: "g", mode: "ongoing", leadBotId: null, parts: {}, runState: "running", closedAt: null, endedAt: null, revision: 1 },
  brief: null, goal: null, budgets: [],
  strip: { line: "Working", needsYou: 0, usage: { workMs: 0, input: 0, output: 0, tokensReported: false, charge: null } },
  sinceYouLeft: { messages: 0, cards: 0, decisions: 0 }, revision: 1,
};
afterEach(() => { effects.length = 0; hooks.callbacks.length = 0; hooks.setters.length = 0; vi.restoreAllMocks(); });

// Node-only fixture: capture the actual effect, then replay its lifecycle as
// StrictMode does. SSR supplies real hooks without requiring a browser or DOM.
it.each([false, true])("loads the board once through mount replay (missing route: %s)", async missing => {
  const read = vi.spyOn(projectClient, "board").mockResolvedValue(missing
    ? { ok: false, unavailable: true, reason: "Project details are not available yet" }
    : { ok: true, data: { lifecycle: "open", columns: [], columnsRevision: 1, cards: [] } });
  renderToStaticMarkup(createElement(ProjectStripDetails, { project, groupId: "g", onBoard: vi.fn() }));
  const boardEffect = effects[0];
  const discarded = boardEffect();
  if (typeof discarded === "function") discarded();
  const cleanup = boardEffect();
  try {
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    // A real replay gap still requests fresh data exactly once.
    projectEvents.replayGap();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
  } finally { if (typeof cleanup === "function") cleanup(); }
  projectEvents.replayGap();
  expect(read).toHaveBeenCalledTimes(2);
});

function deferredBoard() {
  let resolve!: (result: ProjectResult<ProjectBoardRead>) => void;
  const promise = new Promise<ProjectResult<ProjectBoardRead>>(done => { resolve = done; });
  return { promise, resolve };
}

it.each([false, true])("keeps the newest board when an older read finishes last (old failure: %s)", async oldFailure => {
  const old = deferredBoard(), newest = deferredBoard();
  const read = vi.spyOn(projectClient, "board").mockReturnValueOnce(old.promise).mockReturnValueOnce(newest.promise);
  renderToStaticMarkup(createElement(ProjectStripDetails, { project, groupId: "g", onBoard: vi.fn() }));
  const cleanup = effects[0]();
  try {
    await Promise.resolve();
    // Same loader used by the manual/409 path, overlapping the mount/SSE read.
    const manual = hooks.callbacks[0]();
    expect(read).toHaveBeenCalledTimes(2);
    const data: ProjectBoardRead = { lifecycle: "open", columns: [], columnsRevision: 8, cards: [] };
    newest.resolve({ ok: true, data });
    await manual;
    old.resolve(oldFailure ? { ok: false, unavailable: true, reason: "Old failure" } : { ok: true, data: { ...data, columnsRevision: 7 } });
    await Promise.resolve();
    expect(hooks.setters[0].mock.calls).toEqual([[data]]);
    expect(hooks.setters[1].mock.calls).toEqual([[null]]);
  } finally { if (typeof cleanup === "function") cleanup(); }
});

it("discards a board response after effect cleanup", async () => {
  const pending = deferredBoard();
  vi.spyOn(projectClient, "board").mockReturnValue(pending.promise);
  renderToStaticMarkup(createElement(ProjectStripDetails, { project, groupId: "g", onBoard: vi.fn() }));
  const cleanup = effects[0]();
  await Promise.resolve();
  if (typeof cleanup === "function") cleanup();
  pending.resolve({ ok: true, data: { lifecycle: "open", columns: [], columnsRevision: 1, cards: [] } });
  await Promise.resolve();
  expect(hooks.setters[0]).not.toHaveBeenCalled();
});
