// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { initializeProjectTables, prepareProjectTablesForRestore, assertProjectTablesPaused } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { createProjectCard, cancelProjectCard } from "./project-cards.ts";
import { insertRoomRequest, projectCardById, roomRequestById } from "./project-records.ts";
import { handleProjectRoute, handleProjectRouteWithInterrupt, type ProjectRouteInput } from "./project-routes.ts";
import { projectMainThread } from "./project-routines.ts";
import { DATA_DIR } from "./config.ts";
import { audienceFingerprint } from "./owner-audience.ts";
import { launchVerificationServer } from "../scripts/control-murage.ts";

mkdirSync(DATA_DIR, { recursive: true });
const rows = { groups: [{ id: "g", channelProject: {} }], botIds: new Set(["lead", "worker", "reviewer"]), now: 5 };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const owner = { kind: "owner" as const };
function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db); initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "Rules", leadBotId: "lead", now: 1 });
  const group = { id: "g", memberIds: ["lead", "worker", "reviewer"], threadId: "room" };
  const route = (cardId: string, body: object, origin: "desktop" | "companion" = "desktop"): ProjectRouteInput => ({ method: "PATCH", path: `/api/groups/g/board/cards/${cardId}`, body: { expectedRevision: projectCardById(db, cardId)!.revision, ...body }, group, query: new URLSearchParams(), now: 8, origin });
  function card(dependsOn: string[] = []) {
    const made = createProjectCard(db, { groupId: "g", title: "Card", assigneeBotId: "worker", dependsOn, actor: owner, memberIds: group.memberIds, now: 2 });
    if (!made.ok) throw new Error(made.reason); return made.card;
  }
  return { db, group, route, card };
}

it.each([false, true])("F1 restore preserves dead blocked waits and rewrites live waits: live=%s", live => {
  const { db, card } = fixture(); const c = card();
  if (live) insertRoomRequest(db, { id: "run", groupId: "g", verb: "assign", fromKind: "bot", admissionKey: "run", state: "waiting_owner", now: 2 });
  db.prepare("UPDATE project_work_items SET state='waiting', waiting_on=?, reason='Need the source', request_id=? WHERE id=?").run(JSON.stringify({ kind: "blocked" }), live ? "run" : null, c.id);
  prepareProjectTablesForRestore(db, { groups: [{ id: "g", channelProject: {} }], botIds: new Set(["lead", "worker"]), now: 5 });
  expect(projectCardById(db, c.id)).toMatchObject({ waitingOn: { kind: live ? "restore" : "blocked" }, reason: live ? "Interrupted by a restore" : "Need the source" });
  expect(() => assertProjectTablesPaused(db, rows)).not.toThrow();
});
it("F1 paused validation accepts an untouched dead blocked wait", () => {
  const { db, card } = fixture(); const c = card();
  db.prepare("UPDATE project_settings SET run_state='paused', work_profile='ask', work_roots='[]'").run();
  db.prepare("UPDATE project_work_items SET state='waiting', waiting_on=?, reason='Need the source' WHERE id=?").run(JSON.stringify({ kind: "blocked" }), c.id);
  expect(() => assertProjectTablesPaused(db, rows)).not.toThrow();
});
it.each(["desktop", "companion"] as const)("F2 owner card requests carry %s lineage for every queue action", origin => {
  const { db, card, route, group } = fixture();
  for (const [state, body] of [["todo", { action: "start" }], ["failed", { action: "retry" }], ["review", { action: "move", toState: "todo" }], ["todo", { action: "reassign", assigneeBotId: "reviewer" }], ["todo", { action: "move", toState: "doing" }]] as const) {
    const c = card(); db.prepare("UPDATE project_work_items SET state=? WHERE id=?").run(state, c.id);
    const result = handleProjectRoute(db, route(c.id, body, origin));
    expect(result?.status).toBe(200);
    const request = roomRequestById(db, String(result?.body.requestId));
    expect(request).toMatchObject({ from_kind: "owner", origin, root_thread_id: group.threadId, audience_fingerprint: audienceFingerprint(group.threadId, { origin: origin as "desktop" | "companion", rootThreadId: group.threadId }) });
  }
});
it("F2 the row writer refuses server origin on owner actions", () => {
  const { db } = fixture();
  expect(() => insertRoomRequest(db, { groupId: "g", verb: "assign", fromKind: "owner", origin: "server", admissionKey: "bad", now: 3 })).toThrow();
  expect(db.prepare("SELECT * FROM room_requests").all()).toHaveLength(0);
});
it("F3 legacy PATCH refuses every project edit except End", async () => {
  const server = await launchVerificationServer(process.env);
  try {
    const proof = await fetch(`${server.info.url}/api/desktop-secret`).then(r => r.json()) as { secret: string };
    const api = async (method: string, path: string, body: unknown) => {
      const response = await fetch(`${server.info.url}${path}`, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const bot = await api("POST", "/api/bots", { name: "Lead" });
    const group = await api("POST", "/api/groups", { name: "Project", memberIds: [bot.body.bot.id], channelProject: { goal: "Ship" } });
    expect(group.status).toBe(201);
    for (const channelProject of [{ goal: "Bypass" }, {}, { status: "active" }, "bad", false]) {
      expect(await api("PATCH", `/api/groups/${group.body.group.id}`, { channelProject })).toMatchObject({ status: 409, body: { error: "not_allowed", reason: expect.stringMatching(/brief.*goal/i) } });
    }
    expect((await api("PATCH", `/api/groups/${group.body.group.id}`, { channelProject: null })).status).toBe(200);
  } finally { await server.close(); }
}, 60000);
it.each(["take_over", "done", "reassign"])("F4 %s cancels queued requests and descendants", async action => {
  const { db, card, route } = fixture(); const c = card();
  insertRoomRequest(db, { id: "queued", groupId: "g", workItemId: c.id, verb: "assign", fromKind: "bot", admissionKey: "queued", now: 3 });
  insertRoomRequest(db, { id: "child", groupId: "g", parentId: "queued", verb: "ask", fromKind: "bot", admissionKey: "child", state: "waiting_bot", now: 3 });
  const result = await handleProjectRouteWithInterrupt(db, route(c.id, { action, confirm: true, assigneeBotId: "reviewer" }), async () => {});
  expect(result?.status).toBe(200);
  for (const id of ["queued", "child"]) expect(roomRequestById(db, id)?.state).toBe("cancelled");
});
it.each(["take_over", "reassign"])("F4 %s cancels and interrupts the running reviewer", async action => {
  const { db, card, route } = fixture(); const c = card();
  db.prepare("UPDATE project_work_items SET state='review', review_request_id='review' WHERE id=?").run(c.id);
  insertRoomRequest(db, { id: "review", groupId: "g", workItemId: c.id, verb: "review", fromKind: "bot", toBotId: "reviewer", targetThreadId: "review-desk", admissionKey: "review", state: "running", now: 3 });
  const interrupted: unknown[] = [];
  const result = await handleProjectRouteWithInterrupt(db, route(c.id, { action, assigneeBotId: "lead" }), async target => { interrupted.push(target); });
  expect(result?.status).toBe(200); expect(roomRequestById(db, "review")?.state).toBe("cancelled");
  expect(interrupted).toEqual([{ id: c.id, requestId: "review", backoff: false, assigneeBotId: "reviewer", deskThreadId: "review-desk" }]);
});
it("F5 the main chat is group.threadId even with older task threads", () => {
  expect(projectMainThread({ threadId: "room", tasks: [{ threadId: "old-task", createdAt: 1 }] })).toBe("room");
});
it("F6 the project routine callback stores the legacy user prompt marker", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const callback = source.slice(source.indexOf("  projectRoutine: run => {"), source.indexOf("  createGoalTask:", source.indexOf("  projectRoutine: run => {")));
  expect(callback).toMatch(/appendMessage\(threadId, \{ role: "user"/);
  expect(callback).toContain('routineRunPrompt: { trigger: run.manual ? "manual" : "schedule", routineName: run.routineName }');
});
it.each(["cancelled", "missing"])("F8 %s dependencies release on enqueue with Activity", state => {
  const { db, card, route } = fixture(); const dependency = card();
  if (state === "missing") db.prepare("DELETE FROM project_work_items WHERE id=?").run(dependency.id);
  else cancelProjectCard(db, { cardId: dependency.id, actor: owner, now: 3 });
  const c = card([dependency.id]);
  const result = handleProjectRoute(db, route(c.id, { action: "start" }));
  expect(result?.status).toBe(200); expect(roomRequestById(db, String(result?.body.requestId))?.refusal).toBeNull();
  expect(projectCardById(db, c.id)?.waitingOn).toBeNull();
  expect(db.prepare("SELECT * FROM project_activity WHERE work_item_id=? AND json_extract(detail,'$.dependencyReleased')=?").all(c.id, dependency.id)).toHaveLength(1);
});
it("F8 cancelling a dependency releases its already queued dependent", () => {
  const { db, card, route } = fixture(); const dependency = card(); const c = card([dependency.id]);
  const result = handleProjectRoute(db, route(c.id, { action: "start" }));
  expect(roomRequestById(db, String(result?.body.requestId))?.refusal).toBe("dependency");
  cancelProjectCard(db, { cardId: dependency.id, actor: owner, now: 9 });
  expect(roomRequestById(db, String(result?.body.requestId))?.refusal).toBeNull();
  expect(projectCardById(db, c.id)?.waitingOn).toBeNull();
  expect(db.prepare("SELECT * FROM project_activity WHERE work_item_id=? AND json_extract(detail,'$.dependencyReleased')=?").all(c.id, dependency.id)).toHaveLength(1);
});

it("F2 unproven routes cannot spoof owner lineage in their body", () => {
  const { db, card, route } = fixture(); const c = card();
  const input = route(c.id, { action: "start" });
  delete input.origin;
  expect(handleProjectRoute(db, input)?.status).toBe(409);
  input.body = { ...(input.body as object), origin: "desktop" };
  expect(handleProjectRoute(db, input)?.status).toBe(400);
  expect(db.prepare("SELECT * FROM room_requests").all()).toHaveLength(0);
});
it("F8 rechecking an already queued card releases a deleted dependency once", () => {
  const { db, card, route } = fixture(); const dependency = card(); const c = card([dependency.id]);
  const first = handleProjectRoute(db, route(c.id, { action: "start" }));
  expect(roomRequestById(db, String(first?.body.requestId))?.refusal).toBe("dependency");
  db.prepare("DELETE FROM project_work_items WHERE id=?").run(dependency.id);
  const second = handleProjectRoute(db, route(c.id, { action: "start" }));
  expect(second?.body.requestId).toBe(first?.body.requestId);
  expect(roomRequestById(db, String(first?.body.requestId))?.refusal).toBeNull();
  expect(projectCardById(db, c.id)).toMatchObject({ waitingOn: null, dependsOn: [] });
  handleProjectRoute(db, route(c.id, { action: "start" }));
  expect(db.prepare("SELECT * FROM project_activity WHERE work_item_id=? AND json_extract(detail,'$.dependencyReleased')=?").all(c.id, dependency.id)).toHaveLength(1);
});
