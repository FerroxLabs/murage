// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { describe, expect, it } from "vitest";
import type { ProjectBoardRead, ProjectCard, RoomRequest } from "./project-client";
import { boardColumns, cardsInColumn, filterCards, cardFace, planMove, applyOptimistic, revertOptimistic, boardInvalidation, boardAnnouncements, keyboardBoard, swimlanes, planLaneDrop, boardLayout, editColumns, columnsBody, ownerActions, boardWriteFailure, isLiveWait } from "./project-board";
export const card = (patch: Partial<ProjectCard> = {}): ProjectCard => ({ id: "c", number: 12, title: "Payments reconciler", state: "todo", revision: 4, position: 0, createdAt: 0, assigneeBotId: "a", ...patch });
export const board = (cards = [card()]): ProjectBoardRead => ({ lifecycle: "open", columnsRevision: 2, columns: [
  ...["todo", "doing", "waiting", "review", "done"].map((state, position) => ({ id: state, title: state === "review" ? "Client approval" : state, state, position })),
  { id: "custom", title: "Next", state: "todo", position: 0.5 },
], cards });
const members = [{ id: "b", name: "Zed" }, { id: "a", name: "Ada" }];
describe("board placement and faces", () => {
  it("orders server titles and custom columns, appends archive only on request", () => {
    expect(boardColumns(board()).map(c => c.id)).toEqual(["todo", "custom", "doing", "waiting", "review", "done"]);
    expect(boardColumns(board(), true).at(-1)?.id).toBe("archived");
    expect(boardColumns(board()).find(c => c.id === "review")?.title).toBe("Client approval");
  });
  it("falls back from missing or mismatched columns and sorts by position then number", () => {
    const b = board([card({ id: "a", number: 2, columnId: "missing" }), card({ id: "b", number: 1, columnId: "waiting" }), card({ id: "d", state: "failed", columnId: "custom" }), card({ id: "e", state: "cancelled" })]);
    expect(cardsInColumn(b, "todo").map(c => c.number)).toEqual([1, 2]);
    expect(cardsInColumn(b, "waiting").map(c => c.id)).toEqual(["d"]);
    expect(cardsInColumn(b, "archived").map(c => c.id)).toEqual(["e"]);
  });
  it("combines bot, goal, needs me, blocked and archive filters", () => {
    const cards = [card(), card({ id: "owner", ownerTookOver: true }), card({ id: "none", assigneeBotId: null }), card({ id: "fail", state: "failed", goalId: "g" }), card({ id: "wait", state: "waiting", waitingOn: { kind: "owner_approval" } }), card({ id: "dep", waitingOn: { kind: "dependency" } }), card({ id: "old", state: "cancelled" })];
    expect(filterCards(cards, { bot: "you" }).map(c => c.id)).toEqual(["owner"]);
    expect(filterCards(cards, { bot: "unassigned" }).map(c => c.id)).toEqual(["none"]);
    expect(filterCards(cards, { goal: "g", needsMe: true }).map(c => c.id)).toEqual(["fail"]);
    expect(filterCards(cards, { needsMe: true })).toHaveLength(2);
    expect(filterCards(cards, { blocked: true }).map(c => c.id)).toEqual(["dep"]);
    expect(filterCards(cards, { showArchived: true })).toHaveLength(7);
  });
  it.each(["restart", "stopped", "owner", "owner_approval"])("needs me includes %s", kind => expect(filterCards([card({ state: "waiting", waitingOn: { kind } })], { needsMe: true })).toHaveLength(1));
  it.each(["blocked", "dependency", "writer_root", "engine_problem"])("blocked includes %s", kind => expect(filterCards([card({ state: "waiting", waitingOn: { kind } })], { blocked: true })).toHaveLength(1));
  it("derives all face fields with no invented token count or reviewer decision", () => {
    const c = card({ goalId: "goal", dueAt: 1, usage: { workMs: 4800000, tokens: 30, tokensReported: true }, dependsOn: ["dep"], requestId: "r", waitingOn: { kind: "dependency", detail: "Waiting for input" } });
    const face = cardFace(c, members, [{ id: "goal", title: "Close Desk", state: "working", revision: 1 }], [{ id: "r", state: "queued" } as RoomRequest], [card({ id: "dep", number: 7 })], 2);
    expect(face).toMatchObject({ assignee: "Ada", avatarId: "a", goalTitle: "Close Desk", time: "past due", work: "1 h 20 min", tokens: "30 tokens", queued: true, dependency: "waiting for card 7", depends: 1, reason: "Waiting for input" });
    expect(cardFace(card({ ownerTookOver: true }), members, [], [], [], 10800000)).toMatchObject({ assignee: "You", time: "3 h", tokens: null });
    expect(cardFace(card({ assigneeBotId: null, state: "review" }), members).review).toBe(true);
    expect(cardFace(card({ state: "failed", reason: "Stopped" }), members)).toMatchObject({ failed: true, reason: "Stopped" });
    expect(filterCards([card({ state: "review" })], { needsMe: true })).toEqual([]);
  });
  // AFTER-PF round 11 (D3): a running card's next turn sat queued behind a
  // paused goal and the card said nothing about why.
  it("an open card of a paused goal says it waits on the goal and how to go on", () => {
    const paused = [{ id: "goal", title: "Launch", state: "paused" as const, revision: 1 }];
    const line = "Waiting: the goal is paused. Open the goal and press Resume.";
    for (const state of ["todo", "doing", "waiting", "review"] as const) expect(cardFace(card({ goalId: "goal", state }), members, paused).reason).toBe(line);
    expect(cardFace(card({ goalId: "goal", state: "doing", reason: "Stopped" }), members, paused).reason).toBe(line);
    expect(cardFace(card({ goalId: "goal", state: "waiting", waitingOn: { kind: "owner", detail: "Waiting for your answer" } }), members, paused).reason).toBe("Waiting for your answer");
    for (const state of ["done", "cancelled", "failed"] as const) expect(cardFace(card({ goalId: "goal", state }), members, paused).reason).toBeNull();
    expect(cardFace(card({ goalId: "goal", state: "doing" }), members, [{ ...paused[0], state: "working" }]).reason).toBeNull();
  });
});
describe("owner transitions", () => {
  it.each(["review", "failed", "waiting", "cancelled", "done"] as const)("%s to To do follows its owner transition", state => {
    expect(planMove(board([card({ state, waitingOn: { kind: "restart" } })]), "c", { columnId: "todo", index: 0 })).toMatchObject({ ok: true, body: { action: "move", toState: "todo", columnId: null, expectedRevision: 4 } });
  });
  it.each(["todo", "waiting", "failed", "review"] as const)("%s to Done only confirms unreviewed work", state => {
    const p = planMove(board([card({ state })]), "c", { columnId: "done", index: 0 });
    expect(p).toMatchObject({ ok: true, confirm: state !== "review" });
    if (p.ok) expect(p.body.confirm === true).toBe(state !== "review");
  });
  it("allows owner completion, enqueues Start, and refuses starting an unassigned card", () => {
    expect(planMove(board([card({ state: "doing", ownerTookOver: true })]), "c", { columnId: "done", index: 0 })).toMatchObject({ ok: true, confirm: false });
    const p = planMove(board(), "c", { columnId: "doing", index: 0 });
    expect(p).toMatchObject({ ok: true, announcement: "Card 12 is queued to start" });
    expect(applyOptimistic(board(), "c", { columnId: "doing", index: 0 }).cards[0].state).toBe("todo");
    expect(planMove(board([card({ assigneeBotId: null })]), "c", { columnId: "doing", index: 0 }).ok).toBe(false);
  });
  it.each(["todo", "doing", "waiting", "review", "done", "archived"])("refuses an invalid move involving %s", columnId => {
    const source = columnId === "todo" || columnId === "done" ? card({ state: "doing" }) : columnId === "doing" ? card({ state: "review" }) : columnId === "archived" ? card({ state: "done" }) : card();
    expect(planMove(board([source]), "c", { columnId, index: 0 }).ok).toBe(false);
  });
  it.each(["todo", "doing", "waiting", "review", "failed"] as const)("cancels any open %s card", state => expect(planMove(board([card({ state })]), "c", { columnId: "archived", index: 0 })).toMatchObject({ ok: true, body: { toState: "cancelled" } }));
  it("refuses retry from live waits but allows dead blocked wait", () => {
    for (const kind of ["owner_approval", "writer_root", "ask", "blocked"]) {
      const c = card({ state: "waiting", requestId: "r", waitingOn: { kind } });
      expect(isLiveWait(c)).toBe(true);
      expect(planMove(board([c]), "c", { columnId: "todo", index: 0 }).ok).toBe(false);
    }
    expect(isLiveWait(card({ state: "waiting", requestId: null, waitingOn: { kind: "blocked" } }))).toBe(false);
  });
  it("reorders with the actual before/after semantics and retains the original on revert", () => {
    const b = board([card(), card({ id: "a", number: 1, position: 10 }), card({ id: "b", number: 2, position: 20 })]);
    expect(planMove(b, "c", { columnId: "todo", index: 1 })).toMatchObject({ ok: true, body: { action: "reorder", afterCardId: "a", beforeCardId: "b" } });
    const next = applyOptimistic(b, "c", { columnId: "todo", index: 1 });
    expect(cardsInColumn(next, "todo").map(c => c.id)).toEqual(["a", "c", "b"]);
    expect(revertOptimistic(b)).toBe(b); expect(b.cards[0].position).toBe(0);
    expect(planMove(b, "c", { columnId: "custom", index: 0 })).toMatchObject({ ok: true, body: { action: "reorder", columnId: "custom" } });
  });
  it("lists only the applicable card-menu actions", () => {
    expect(ownerActions(card())).toEqual(expect.arrayContaining(["start", "reassign", "take_over", "done", "cancel", "edit"]));
    expect(ownerActions(card({ state: "doing", requestId: "r" }))).toEqual(["reassign", "take_over", "interrupt", "cancel"]);
    expect(ownerActions(card({ state: "review" }))).toEqual(["reassign", "take_over", "accept", "send_back", "cancel"]);
    expect(ownerActions(card({ state: "cancelled" }))).toEqual(["restore"]);
    expect(ownerActions(card({ state: "done" }))).toEqual(["reopen"]);
    expect(ownerActions(card({ requestId: "r" }))).not.toContain("start");
    expect(ownerActions(card({ state: "failed" }))).toContain("retry");
  });
  it("keeps conflict and refusal messages distinct", () => {
    expect(boardWriteFailure({ error: "changed" })).toEqual({ refetch: true, line: "This changed. The board is up to date now." });
    expect(boardWriteFailure({ error: "not_allowed", reason: "Answer first" })).toEqual({ refetch: false, line: "Answer first" });
  });
});
it("ignores stale SSE revisions; higher revisions, deletion, columns and gaps invalidate", () => {
  const change = { strip: false, board: true, requests: false, cards: [{ id: "c", revision: 4, state: "todo" as const, columnId: null }] };
  expect(boardInvalidation(board(), change)).toEqual({ board: false, requests: false, project: false });
  expect(boardInvalidation(board(), { ...change, cards: [{ ...change.cards[0], revision: 5 }] }).board).toBe(true);
  expect(boardInvalidation(board(), { ...change, cards: [{ ...change.cards[0], deleted: true }] }).board).toBe(true);
  expect(boardInvalidation(board(), { ...change, columnsRevision: 3 }).board).toBe(true);
  expect(boardInvalidation(board(), { ...change, replayGap: true })).toEqual({ board: true, requests: true, project: true });
});
it("announces remote moves neutrally, caps at three and omits owner moves", () => {
  const old = board(Array.from({ length: 5 }, (_, i) => card({ id: String(i) })));
  const next = { ...old, cards: old.cards.map(c => ({ ...c, state: "review" as const })) };
  expect(boardAnnouncements(old, next)).toEqual(["'Payments reconciler' moved to Client approval", "'Payments reconciler' moved to Client approval", "'Payments reconciler' moved to Client approval", "and 2 more changes"]);
  expect(boardAnnouncements(old, next, true)).toEqual([]);
});
it("keyboard pickup, horizontal and vertical moves, drop and cancellation preserve focus id", () => {
  const b = board(); const columns = boardColumns(b, true);
  let k = keyboardBoard(null, { type: "focus", cardId: "c" }, b, columns);
  k = keyboardBoard(k, { type: "key", key: " " }, b, columns);
  expect(k?.announcement).toContain("Picked up card 12");
  k = keyboardBoard(k, { type: "key", key: "ArrowRight" }, b, columns);
  expect(k?.target.columnId).toBe("custom");
  k = keyboardBoard(k, { type: "key", key: " " }, b, columns);
  expect(k).toMatchObject({ picked: false, focusId: "c", drop: { ok: true, body: { action: "reorder", columnId: "custom" } } });
  k = keyboardBoard(k, { type: "key", key: "Enter" }, b, columns);
  k = keyboardBoard(k, { type: "key", key: "Escape" }, b, columns);
  expect(k).toMatchObject({ picked: false, focusId: "c", drop: null });
});
it("swimlanes sort members then Unassigned and You; lane changes reassign or take over", () => {
  const lanes = swimlanes(members); expect(lanes.map(l => l.id)).toEqual(["a", "b", "unassigned", "you"]);
  expect(planLaneDrop(board(), "c", "b", { columnId: "done", index: 0 })).toMatchObject({ ok: true, body: { action: "reassign", assigneeBotId: "b", expectedRevision: 4 } });
  expect(planLaneDrop(board(), "c", "you", { columnId: "todo", index: 0 })).toMatchObject({ ok: true, body: { action: "take_over" } });
  expect(planLaneDrop(board(), "c", "unassigned", { columnId: "todo", index: 0 })).toEqual({ ok: false, reason: "Pick a teammate to reassign" });
  let k = keyboardBoard(null, { type: "focus", cardId: "c" }, board(), boardColumns(board()), lanes);
  k = keyboardBoard(k, { type: "key", key: "Enter" }, board(), boardColumns(board()), lanes);
  k = keyboardBoard(k, { type: "key", key: "ArrowDown" }, board(), boardColumns(board()), lanes);
  k = keyboardBoard(k, { type: "key", key: " " }, board(), boardColumns(board()), lanes);
  expect(k?.drop).toMatchObject({ ok: true, body: { action: "reassign", assigneeBotId: "b" } });
});
it.each([[390, "phone"], [639, "phone"], [640, "two"], [820, "two"], [1023, "two"], [1024, "wide"], [1440, "wide"]] as const)("width %i uses %s", (width, layout) => expect(boardLayout(width)).toBe(layout));
it("column edits validate titles, limits, fixed state, full PUT revision, deletion displacement", () => {
  const b = board(); const initial = b.columns.filter(c => c.id === "custom");
  expect(editColumns(initial, { type: "rename", id: "custom", title: " " }, b).ok).toBe(false);
  expect(editColumns(initial, { type: "rename", id: "custom", title: "x".repeat(41) }, b).ok).toBe(false);
  const added = editColumns(initial, { type: "add", id: "two", title: "Ready", state: "todo" }, b);
  if (!added.ok) throw Error("fixture");
  const reordered = editColumns(added.columns, { type: "reorder", id: "two", index: 0 }, b);
  if (!reordered.ok) throw Error("fixture");
  expect(columnsBody(b, reordered.columns)).toMatchObject({ ok: true, body: { expectedRevision: 2, columns: [{ id: "two" }, { id: "custom" }] } });
  expect(columnsBody(b, [{ ...initial[0], state: "done" }]).ok).toBe(false);
  expect(columnsBody(b, Array.from({ length: 13 }, (_, i) => ({ id: `col${i}`, title: "x", state: "todo", position: i }))).ok).toBe(false);
  expect(editColumns(initial, { type: "delete", id: "custom" }, board([card({ columnId: "custom" })]))).toMatchObject({ ok: true, displaced: 1, columns: [] });
});

it("optimistically reassigns and takes over without modifying the held board", async () => {
  const { applyOwnerOptimistic } = await import("./project-board");
  const b = board([card({ state: "doing", requestId: "old" })]);
  expect(applyOwnerOptimistic(b, "c", { action: "reassign", expectedRevision: 4, assigneeBotId: "b" }).cards[0]).toMatchObject({ state: "todo", assigneeBotId: "b", ownerTookOver: false, requestId: null });
  expect(applyOwnerOptimistic(b, "c", { action: "take_over", expectedRevision: 4 }).cards[0]).toMatchObject({ state: "doing", assigneeBotId: null, ownerTookOver: true });
  expect(b.cards[0]).toMatchObject({ state: "doing", assigneeBotId: "a", requestId: "old" });
});

it("keyboard arrows clamp positions, skip Archived and reuse the drag plan", () => {
  const b = board([card(), card({ id: "second", number: 2, position: 1024 })]);
  const columns = boardColumns(b, true);
  let k = keyboardBoard(null, { type: "focus", cardId: "c" }, b, columns);
  k = keyboardBoard(k, { type: "key", key: " " }, b, columns);
  k = keyboardBoard(k, { type: "key", key: "ArrowDown" }, b, columns);
  expect(k?.target.index).toBe(1);
  k = keyboardBoard(k, { type: "key", key: "ArrowDown" }, b, columns);
  expect(k?.target.index).toBe(1);
  const drop = keyboardBoard(k, { type: "key", key: " " }, b, columns);
  expect(drop?.drop).toEqual(planMove(b, "c", { columnId: "todo", index: 1 }));
  for (let i = 0; i < 20; i++) k = keyboardBoard(k, { type: "key", key: "ArrowRight" }, b, columns);
  expect(k?.target.columnId).toBe("done");
  for (let i = 0; i < 20; i++) k = keyboardBoard(k, { type: "key", key: "ArrowLeft" }, b, columns);
  expect(k?.target.columnId).toBe("todo");
});

it("starting by drop never carries destination ordering into To do", () => {
 const b = board([card({position:42}),card({id:"running",state:"doing",position:9000})]);
 const plan = planMove(b,"c",{columnId:"doing",index:1});
 expect(plan.ok).toBe(true); if (!plan.ok) return;
 expect(plan.body.beforeCardId).toBeUndefined(); expect(plan.body.afterCardId).toBeUndefined(); expect(plan.body.columnId).toBeNull();
 expect(applyOptimistic(b,"c",{columnId:"doing",index:1}).cards[0].position).toBe(42);
});
it("repicks the current server place after refusal and after a remote move", () => {
 const b=board(); const columns=boardColumns(b);
 let k=keyboardBoard(null,{type:"focus",cardId:"c"},b,columns);
 for(const key of [" ","ArrowRight"," "," "]) k=keyboardBoard(k,{type:"key",key},b,columns);
 expect(k?.target).toEqual({columnId:"todo",index:0});
 k=keyboardBoard(k,{type:"key",key:"Escape"},b,columns);
 const moved=board([card({columnId:"custom"})]);
 k=keyboardBoard(k,{type:"key",key:" "},moved,columns); expect(k?.target.columnId).toBe("custom");
});
it("keyboard positions use the filtered list and translate to full-board neighbours", () => {
 const b=board([card({position:20}),card({id:"hidden",position:0,assigneeBotId:"b"}),card({id:"visible",position:10})]);
 const shown={...b,cards:filterCards(b.cards,{bot:"a"})}, columns=boardColumns(b);
 let k=keyboardBoard(null,{type:"focus",cardId:"c"},b,columns,undefined,shown);
 k=keyboardBoard(k,{type:"key",key:" "},b,columns,undefined,shown);
 expect(k?.target.index).toBe(1);
 k=keyboardBoard(k,{type:"key",key:"ArrowUp"},b,columns,undefined,shown);
 k=keyboardBoard(k,{type:"key",key:" "},b,columns,undefined,shown);
 expect(k?.drop).toMatchObject({ok:true,body:{beforeCardId:"visible",afterCardId:"hidden"}});
 expect(k?.target.index).toBe(1);
});
it("keyboard pickup in a swimlane counts only that lane", () => {
 const b=board([card({position:20}),card({id:"other-lane",position:0,assigneeBotId:"b"}),card({id:"same-lane",position:10})]);
 const columns=boardColumns(b),lanes=swimlanes(members);
 let k=keyboardBoard(null,{type:"focus",cardId:"c"},b,columns,lanes);
 k=keyboardBoard(k,{type:"key",key:" "},b,columns,lanes); expect(k?.target.index).toBe(1);
 k=keyboardBoard(k,{type:"key",key:" "},b,columns,lanes);
 expect(k?.drop).toMatchObject({ok:true,body:{afterCardId:"same-lane"}});
});
it("idle Escape does not announce a cancellation or repeat a drop", () => {
 const b=board();const k=keyboardBoard(null,{type:"focus",cardId:"c"},b,boardColumns(b));
 expect(keyboardBoard(k,{type:"key",key:"Escape"},b,boardColumns(b))?.announcement).toBe("");
});
it("does not offer unassigned retry or repeated take over", () => {
 for(const state of ["failed","waiting"] as const) expect(ownerActions(card({state,assigneeBotId:null,waitingOn:{kind:"restart"}}))).not.toContain("retry");
 expect(ownerActions(card({state:"doing",ownerTookOver:true}))).not.toContain("take_over");
});
it("announces the rendered landing column for failures and canonical server titles", () => {
 const b=board(); expect(boardAnnouncements(b,board([card({state:"failed"})]))).toEqual(["'Payments reconciler' moved to waiting"]);
 expect(boardAnnouncements(b,board([card({state:"review"})]))).toEqual(["'Payments reconciler' moved to Client approval"]);
});

it("uses queued work-item requests before dispatch sets the card request id", () => {
 const c=card({requestId:null}), b=board([c]);
 const requests=[{id:"queued",verb:"assign",state:"queued",workItemId:c.id} as RoomRequest];
 expect(cardFace(c,members,[],requests).queued).toBe(true);
 expect(ownerActions(c,requests)).not.toContain("start");
 expect(planMove(b,c.id,{columnId:"doing",index:0},requests).ok).toBe(false);
 expect(planLaneDrop(b,c.id,"a",{columnId:"doing",index:0},requests).ok).toBe(false);
 const held={focusId:c.id,picked:true,target:{columnId:"doing",index:0},lane:"a",announcement:"",drop:null};
 expect(keyboardBoard(held,{type:"key",key:" "},b,boardColumns(b),undefined,b,requests)?.drop?.ok).toBe(false);
 expect(ownerActions(c,[{...requests[0],state:"done"}])).toContain("start");
 expect(cardFace(c,members,[],[{...requests[0],workItemId:"other"}]).queued).toBe(false);
});
