// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { useProjectBoard } from "./use-project-board";
import { projectClient, refreshProject } from "./use-project";
import { projectEvents } from "./project-events";
import type { ProjectBoardRead, ProjectResult, RoomRequest } from "./project-client";
const fixture = vi.hoisted(() => ({ refs: [] as Array<{current:unknown}>, cursor: 0, effects: [] as EffectCallback[], setters: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useRef: (initial:unknown) => { const index=fixture.cursor++; return fixture.refs[index] ?? (fixture.refs[index]={current:initial}); }, useEffect: (effect: EffectCallback) => fixture.effects.push(effect), useState: (initial: unknown) => { const set = vi.fn(); fixture.setters.push(set); return [typeof initial === "function" ? initial() : initial, set]; } }));
vi.mock("./use-project", async original => ({ ...await original<typeof import("./use-project")>(), refreshProject: vi.fn() }));
vi.mock("@/state/store", () => ({ api: vi.fn() }));
const original: ProjectBoardRead = { lifecycle: "open", columns: [], columnsRevision: 1, cards: [{ id: "c", title: "Work", number: 1, revision: 1, state: "todo", assigneeBotId: "a" }] };
let api: ReturnType<typeof useProjectBoard>;
let archived=false, groupId="g";
function Probe() { fixture.cursor=0; api = useProjectBoard(groupId, archived, true, original); return null; }
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); archived=false;groupId="g";fixture.refs.length=0;fixture.cursor=0;fixture.effects.length = 0; fixture.setters.length = 0; vi.restoreAllMocks(); vi.useRealTimers(); });
async function mount() {
  vi.spyOn(projectClient, "board").mockResolvedValue({ ok: true, data: original });
  vi.spyOn(projectClient, "requests").mockResolvedValue({ ok: true, data: { lifecycle: "open", requests: [] } });
  renderToStaticMarkup(createElement(Probe));
  const stop = fixture.effects[0](); if (typeof stop === "function") cleanups.push(stop);
  await api.load();
  await Promise.resolve();
}
it("ignores held SSE revisions, coalesces fresh revisions, and refetches all three reads after a gap", async () => {
  await mount(); vi.useFakeTimers(); vi.mocked(projectClient.board).mockClear(); vi.mocked(projectClient.requests).mockClear();
  projectEvents.frame({ kind: "project.board", groupId: "g", cards: [{ id: "c", revision: 1, state: "todo", columnId: null }] });
  await vi.advanceTimersByTimeAsync(250); expect(projectClient.board).not.toHaveBeenCalled();
  for (const revision of [2, 3]) projectEvents.frame({ kind: "project.board", groupId: "g", cards: [{ id: "c", revision, state: "doing", columnId: null }] });
  await vi.advanceTimersByTimeAsync(250); expect(projectClient.board).toHaveBeenCalledTimes(1);
  projectEvents.replayGap(); await vi.advanceTimersByTimeAsync(0);
  expect(projectClient.board).toHaveBeenCalledTimes(2); expect(projectClient.requests).toHaveBeenCalledTimes(1); expect(refreshProject).toHaveBeenCalledWith("g");
});
it("snaps back a refusal and only calls the server once", async () => {
  await mount(); vi.mocked(projectClient.board).mockClear();
  vi.spyOn(projectClient, "card").mockResolvedValue({ ok: false, unavailable: false, status: 409, reason: "Answer first", body: { error: "not_allowed", reason: "Answer first" } });
  expect(await api.write("c", { action: "move", toState: "done", expectedRevision: 1, confirm: true }, "done", { columnId: "done", index: 0 })).toBe(false);
  expect(projectClient.card).toHaveBeenCalledTimes(1); expect(projectClient.board).not.toHaveBeenCalled();
  expect(fixture.setters[0]).toHaveBeenLastCalledWith(original); expect(fixture.setters[3]).toHaveBeenLastCalledWith("Answer first");
});
it("refetches a changed conflict and reports the refreshed server truth", async () => {
  await mount(); vi.mocked(projectClient.board).mockClear();
  const current = { ...original, cards: [{ ...original.cards[0], revision: 2, state: "review" as const }] };
  vi.mocked(projectClient.board).mockResolvedValue({ ok: true, data: current });
  vi.spyOn(projectClient, "card").mockResolvedValue({ ok: false, unavailable: false, status: 409, reason: "changed", body: { error: "changed" } });
  await api.write("c", { action: "take_over", expectedRevision: 1 }, "take over");
  expect(projectClient.board).toHaveBeenCalledTimes(1); expect(fixture.setters[0]).toHaveBeenLastCalledWith(current);
  expect(fixture.setters[3]).toHaveBeenLastCalledWith("This changed. The board is up to date now.");
});

it("suppresses additions on the first read of each archive generation, then announces remote updates", async () => {
 await mount(); cleanups.pop()!();
 const archived={...original,cards:[...original.cards,{id:"archived",number:2,title:"Old",state:"cancelled" as const,revision:1}]};
 vi.mocked(projectClient.board).mockResolvedValue({ok:true,data:archived});
 fixture.setters[2].mockClear(); const stop=fixture.effects[0](); if(typeof stop==="function")cleanups.push(stop);
 await api.load();await Promise.resolve();expect(fixture.setters[2]).not.toHaveBeenCalled();
 vi.mocked(projectClient.board).mockResolvedValue({ok:true,data:{...archived,cards:[...archived.cards,{id:"new",number:3,title:"New",state:"todo",revision:1}]}});
 await api.load();expect(fixture.setters[2]).toHaveBeenLastCalledWith("Card 3 was added");
});

function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;}); return {promise,resolve}; }
async function rerender() {
 cleanups.pop()!();renderToStaticMarkup(createElement(Probe));
 const stop=fixture.effects.at(-1)!();if(typeof stop === "function")cleanups.push(stop);
 await Promise.resolve();await Promise.resolve();await Promise.resolve();
}
it("fences reversed request responses and responses from a previous view",async()=>{
 await mount();
 const first=deferred<ProjectResult<{lifecycle:"open";requests:RoomRequest[]}>>();
 const queued=[{id:"new",state:"queued",workItemId:"c"} as RoomRequest];
 vi.mocked(projectClient.requests).mockReturnValueOnce(first.promise).mockResolvedValue({ok:true,data:{lifecycle:"open",requests:queued}});
 projectEvents.replayGap();projectEvents.replayGap();await Promise.resolve();
 first.resolve({ok:true,data:{lifecycle:"open",requests:[]}});await Promise.resolve();
 expect(fixture.setters[1]).toHaveBeenLastCalledWith(queued);
 const old=deferred<ProjectResult<{lifecycle:"open";requests:RoomRequest[]}>>();vi.mocked(projectClient.requests).mockReturnValueOnce(old.promise);
 projectEvents.replayGap();await api.load();groupId="other";await rerender();await api.load();
 const calls=fixture.setters[1].mock.calls.length;old.resolve({ok:true,data:{lifecycle:"open",requests:[]}});await Promise.resolve();
 expect(fixture.setters[1]).toHaveBeenCalledTimes(calls);
});
it("Cancel refresh uses the current archive query after its delayed PATCH",async()=>{
 await mount();const patch=deferred<ProjectResult<{card:ProjectBoardRead["cards"][number]}>>();
 vi.spyOn(projectClient,"card").mockReturnValue(patch.promise);
 const writing=api.write("c",{action:"cancel",expectedRevision:1},"cancelled");
 archived=true;await rerender();await api.load();
 const archivedBoard={...original,cards:[{...original.cards[0],state:"cancelled" as const,revision:2}]};
 vi.mocked(projectClient.board).mockImplementation(async(_group,query)=>({ok:true,data:query?.archived?archivedBoard:original}));
 patch.resolve({ok:true,data:{card:archivedBoard.cards[0]}});await writing;
 expect(projectClient.board).toHaveBeenLastCalledWith("g",{archived:true});
 expect(api.getBoard()).toEqual(archivedBoard);
});
it("rejects a board read from the previous archive query",async()=>{
 await mount();const old=deferred<ProjectResult<ProjectBoardRead>>();vi.mocked(projectClient.board).mockReturnValueOnce(old.promise);
 const reading=api.load();archived=true;await rerender();
 const count=fixture.setters[0].mock.calls.length;old.resolve({ok:true,data:{...original,columnsRevision:99}});await reading;
 expect(fixture.setters[0].mock.calls.slice(count).some(([value])=>value.columnsRevision===99)).toBe(false);
 await api.load();
});
