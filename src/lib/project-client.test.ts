// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { afterEach, expect, it, vi } from "vitest";
import { createProjectClient, projectSurfaceEnabled } from "./project-client";
import { createProjectEvents } from "./project-events";

afterEach(() => vi.useRealTimers());
it("keeps old servers off and leaves paused autonomy visible", () => {
  expect(projectSurfaceEnabled(null)).toBe(false);
  expect(projectSurfaceEnabled({ features: {} })).toBe(false);
  expect(projectSurfaceEnabled({ features: { projectsLead: true, roomsQueue: true, projectsAutonomy: false } })).toBe(true);
});
it("calls only the specified routes with their exact bodies", async () => {
  const send = vi.fn().mockResolvedValue({ ok: true });
  const client = createProjectClient(send);
  await client.project("g"); await client.viewed("g");
  await client.control("g", "pause"); await client.control("g", "resume"); await client.control("g", "stop");
  await client.redirect("g", { clientId: "once", text: "Check the result" });
  await client.requests("g", { open: true, limit: 25 });
  await client.cancel("g", "r"); await client.retry("g", "r", "b"); await client.usage("g");
  expect(send.mock.calls.map(([path]) => path)).toEqual([
    "/api/groups/g/project", "/api/groups/g/project/viewed", "/api/groups/g/project/control/pause",
    "/api/groups/g/project/control/resume", "/api/groups/g/project/control/stop", "/api/groups/g/project/control/redirect",
    "/api/groups/g/requests?open=1&limit=25", "/api/groups/g/requests/r/cancel", "/api/groups/g/requests/r/retry", "/api/groups/g/usage",
  ]);
  expect(JSON.parse(send.mock.calls[5][1].body)).toEqual({ clientId: "once", text: "Check the result" });
  expect(JSON.parse(send.mock.calls[8][1].body)).toEqual({ assigneeBotId: "b" });
});
it("returns unavailable without automatic retries or throwing on a missing server", async () => {
  const send = vi.fn().mockRejectedValue(Object.assign(new Error("no such route"), { status: 404 }));
  const client = createProjectClient(send);
  expect(await client.project("g")).toEqual({ ok: false, unavailable: true, status: 404, reason: "Project details are not available yet" });
  send.mockRejectedValueOnce(new TypeError("network"));
  expect(await client.usage("g")).toMatchObject({ ok: false, unavailable: true });
  expect(send).toHaveBeenCalledTimes(2);
});
it("retains 403 and both 409 shapes for inline refusals and refetch", async () => {
  const send = vi.fn(); const client = createProjectClient(send);
  for (const [status, body, reason] of [
    [403, { error: "This needs the Murage app on your computer." }, "This needs the Murage app on your computer."],
    [409, { error: "not_allowed", reason: "This project is closed" }, "This project is closed"],
    [409, { error: "changed", settings: { revision: 4 } }, "This changed. Refresh and try again."],
  ] as const) {
    send.mockRejectedValueOnce(Object.assign(new Error(body.error), { status, body }));
    expect(await client.control("g", "resume")).toMatchObject({ ok: false, status, reason, body });
  }
});
it("coalesces by group at 250 ms with highest revisions and deletion winning", () => {
  vi.useFakeTimers(); const events = createProjectEvents(); const receive = vi.fn();
  const stop = events.subscribe("g", receive);
  events.frame({ kind: "project.board", groupId: "g", cards: [{ id: "c", revision: 2, state: "doing", columnId: null }], columnsRevision: 3 });
  events.frame({ kind: "project.board", groupId: "g", cards: [{ id: "c", revision: 1, state: "todo", columnId: null }, { id: "d", revision: 1, state: "cancelled", columnId: null, deleted: true }], columnsRevision: 2 });
  events.frame({ kind: "project.strip", groupId: "other" });
  events.frame({ kind: "room.requests", groupId: "g", threadId: "t" });
  vi.advanceTimersByTime(249); expect(receive).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(receive).toHaveBeenCalledTimes(1);
  expect(receive.mock.calls[0][0]).toMatchObject({ board: true, requests: true, columnsRevision: 3, cards: [{ id: "c", revision: 2 }, { id: "d", deleted: true }] });
  events.frame({ kind: "project.board", groupId: "g", cards: [{ id: "c", revision: 1, state: "todo", columnId: null }] });
  vi.advanceTimersByTime(250); expect(receive).toHaveBeenCalledTimes(1);
  events.replayGap(); expect(receive.mock.calls.at(-1)?.[0]).toMatchObject({ strip: true, board: true, requests: true, replayGap: true });
  stop(); events.frame({ kind: "project.strip", groupId: "g" }); vi.advanceTimersByTime(250);
  expect(receive).toHaveBeenCalledTimes(2);
});

it("reads board cards and sends only revision-fenced owner card actions", async () => {
  const card = { id: "c/1", title: "Review result", state: "doing", revision: 7, assigneeBotId: "a" };
  const board = { lifecycle: "open", columns: [], columnsRevision: 2, cards: [card] };
  const send = vi.fn().mockResolvedValueOnce(board).mockResolvedValue({ card: { ...card, revision: 8 } });
  const client = createProjectClient(send);
  expect(await client.board("g/1")).toEqual({ ok: true, data: board });
  await client.card("g/1", card.id, { action: "reassign", expectedRevision: card.revision, assigneeBotId: "b" });
  await client.card("g/1", card.id, { action: "take_over", expectedRevision: 8 });
  expect(send.mock.calls[0][0]).toBe("/api/groups/g%2F1/board");
  expect(send.mock.calls[1]).toEqual(["/api/groups/g%2F1/board/cards/c%2F1", { method: "PATCH", body: JSON.stringify({ action: "reassign", expectedRevision: 7, assigneeBotId: "b" }) }]);
  expect(JSON.parse(send.mock.calls[2][1].body)).toEqual({ action: "take_over", expectedRevision: 8 });
});
it("returns missing board and changed card reasons without replaying writes", async () => {
  const send = vi.fn().mockRejectedValueOnce({ status: 404 }).mockRejectedValueOnce({ status: 409, body: { error: "changed", card: { revision: 9 } } });
  const client = createProjectClient(send);
  expect(await client.board("g")).toMatchObject({ ok: false, unavailable: true });
  expect(await client.card("g", "c", { action: "take_over", expectedRevision: 7 })).toMatchObject({ ok: false, status: 409, body: { error: "changed" } });
  expect(send).toHaveBeenCalledTimes(2);
});

it("sends archive, history, idempotent create and full column revision contracts", async () => {
  const send = vi.fn().mockResolvedValue({}); const client = createProjectClient(send);
  await client.board("g", { archived: true, goal: "goal", bot: "bot" });
  await client.activity("g", { card: "c-1", before: 123, limit: 30 });
  await client.createCard("g", { clientId: "once", title: "Draft", writes: true });
  await client.columns("g", { expectedRevision: 8, columns: [{ id: "custom", state: "todo", title: "Next", position: 2 }] });
  expect(send.mock.calls[0][0]).toBe("/api/groups/g/board?archived=1&goal=goal&bot=bot");
  expect(send.mock.calls[1][0]).toBe("/api/groups/g/activity?card=c-1&before=123&limit=30");
  expect(send.mock.calls[2]).toEqual(["/api/groups/g/board/cards", { method: "POST", body: JSON.stringify({ clientId: "once", title: "Draft", writes: true }) }]);
  expect(send.mock.calls[3][1].method).toBe("PUT"); expect(JSON.parse(send.mock.calls[3][1].body).expectedRevision).toBe(8);
});

it("writes goal creation, revision-fenced actions and digest settings without losing parts", async () => {
  const send = vi.fn().mockResolvedValue({}); const client = createProjectClient(send);
  await client.createGoal("g", {title:"Launch",criteria:["Checked"],planFirst:false,review:true});
  await client.goal("g", "goal", {expectedRevision:7,action:"sign_off"});
  await client.goal("g", "goal", {expectedRevision:8,action:"send_back",note:"Check it"});
  await client.settings("g", {expectedRevision:9,parts:{board:true,review:true,digest:true}});
  expect(send.mock.calls.map(([path,init])=>[path,init.method,JSON.parse(init.body)])).toEqual([
    ["/api/groups/g/project/goals","POST",{title:"Launch",criteria:["Checked"],planFirst:false,review:true}],
    ["/api/groups/g/project/goals/goal","PATCH",{expectedRevision:7,action:"sign_off"}],
    ["/api/groups/g/project/goals/goal","PATCH",{expectedRevision:8,action:"send_back",note:"Check it"}],
    ["/api/groups/g/project/settings","PATCH",{expectedRevision:9,parts:{board:true,review:true,digest:true}}],
  ]);
});

it("sends lifecycle confirmations and export selection explicitly",async()=>{
  const send=vi.fn().mockResolvedValue({});const client=createProjectClient(send);
  await client.close("g");await client.close("g",true);await client.reopen("g");await client.end("g");await client.exportBrief("g",1);
  expect(send.mock.calls.map(([path,init])=>[path,init.method,JSON.parse(init.body)])).toEqual([
    ["/api/groups/g/project/close","POST",{}],["/api/groups/g/project/close","POST",{stopGoal:true}],
    ["/api/groups/g/project/reopen","POST",{}],["/api/groups/g","PATCH",{channelProject:null}],
    ["/api/groups/g/project/export-brief","POST",{workRootIndex:1}],
  ]);
});

it("saves Cards at once to the desktop settings route with the current revision", async () => {
  const send = vi.fn().mockResolvedValue({ settings: { parallelCards: 5 } });
  expect(await createProjectClient(send).parallelCards("g/1", 7, 5)).toMatchObject({ ok: true });
  expect(send).toHaveBeenCalledExactlyOnceWith("/api/groups/g%2F1/project/settings", { method: "PATCH", body: JSON.stringify({ expectedRevision: 7, parallelCards: 5 }) });
});
