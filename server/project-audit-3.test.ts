// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
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

// Local to F3's repeatable owner creates/edits. Do not apply this to arbitrary sends.
function projectOwnerApi(baseUrl: string, secret: string, send = fetch,
  wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  return async (method: "POST" | "PATCH", path: string, body: unknown) => {
    const url = `${baseUrl}${path}`;
    const request = { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret }, body: JSON.stringify(body) };
    for (let attempt = 1; ; attempt++) {
      const response = await send(url, request);
      const answer = { status: response.status, body: await response.json() as Record<string, any> };
      if (attempt === 5 || answer.status !== 503 || answer.body?.code !== "DATABASE_BUSY" || answer.body?.retryable !== true) return answer;
      // busyJson supplies Retry-After in seconds. Default to 1 s and cap each wait at 5 s.
      const seconds = Number(response.headers.get("retry-after") || "1");
      const delay = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 5) * 1000 : 1000;
      await wait(delay);
    }
  };
}

it.each(["POST", "PATCH"] as const)("F3 HTTP helper repeats the identical %s owner request after retryable busy", async method => {
  const busy = { code: "DATABASE_BUSY", retryable: true };
  const send = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(busy), { status: 503, headers: { "retry-after": "2" } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "created" }), { status: 201 }));
  let resume!: () => void;
  let waiting!: () => void;
  const startedWaiting = new Promise<void>(resolve => { waiting = resolve; });
  const wait = vi.fn((_ms: number) => new Promise<void>(resolve => { resume = resolve; waiting(); }));
  const body = { name: "Lead" };
  const result = projectOwnerApi("http://fixture.invalid", "fixture-proof", send, wait)(method, "/api/bots", body);
  await startedWaiting;
  expect(send).toHaveBeenCalledTimes(1);
  expect(wait).toHaveBeenCalledWith(2000);
  body.name = "Changed while waiting";
  resume();
  expect(await result).toEqual({ status: 201, body: { id: "created" } });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(send.mock.calls[1]).toEqual(["http://fixture.invalid/api/bots", {
    method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": "fixture-proof" }, body: '{"name":"Lead"}',
  }]);
});

it.each([
  ["1", 1000], ["999", 5000], [undefined, 1000], ["invalid", 1000], ["-1", 1000], ["Infinity", 1000],
] as const)("F3 HTTP helper bounds Retry-After %s and returns the fifth busy response", async (retryAfter, delay) => {
  const busy = { code: "DATABASE_BUSY", retryable: true, error: "Still busy" };
  const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(busy), {
    status: 503, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
  }));
  const wait = vi.fn(async (_ms: number) => {});
  expect(await projectOwnerApi("http://fixture.invalid", "fixture-proof", send, wait)("POST", "/api/bots", { name: "Lead" }))
    .toEqual({ status: 503, body: busy });
  expect(send).toHaveBeenCalledTimes(5);
  expect(wait.mock.calls).toEqual([[delay], [delay], [delay], [delay]]);
});

it.each([
  { status: 201, body: { bot: { id: "created" } } },
  { status: 409, body: { code: "DATABASE_BUSY", retryable: true } },
  { status: 500, body: { code: "DATABASE_BUSY", retryable: true } },
  { status: 503, body: { code: "OTHER", retryable: true } },
  { status: 503, body: { code: "DATABASE_BUSY", retryable: false } },
  { status: 503, body: { code: "DATABASE_BUSY", retryable: "true" } },
  { status: 503, body: { code: "DATABASE_BUSY" } },
  { status: 503, body: null },
])("F3 HTTP helper returns other answers unchanged: %j", async answer => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(answer.body), { status: answer.status }));
  const wait = vi.fn(async (_ms: number) => {});
  expect(await projectOwnerApi("http://fixture.invalid", "fixture-proof", send, wait)("PATCH", "/api/groups/project", { channelProject: null })).toEqual(answer);
  expect(send).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});

it("F3 HTTP helper does not repeat a request after a transport error", async () => {
  const error = new Error("Connection closed");
  const send = vi.fn<typeof fetch>().mockRejectedValue(error);
  const wait = vi.fn(async (_ms: number) => {});
  await expect(projectOwnerApi("http://fixture.invalid", "fixture-proof", send, wait)("POST", "/api/bots", { name: "Lead" })).rejects.toBe(error);
  expect(send).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});

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
    const api = projectOwnerApi(server.info.url, proof.secret);
    // A create is checked for its 201 before its body is read, so a refused create names its status, its answer and the
    // server's own log (CI 40179744623 read the missing bot as "reading 'id'" with none of these). Like the client, the
    // helper repeats only retryable DATABASE_BUSY replies; a final refusal still includes this evidence.
    const create = async (path: string, body: unknown) => {
      const answer = await api("POST", path, body);
      if (answer.status !== 201) {
        let log = "";
        try { log = readFileSync(server.info.logPath, "utf8").slice(-4000); } catch { /* the log is evidence only */ }
        expect.fail(`POST ${path} answered ${answer.status} ${JSON.stringify(answer.body)}\nserver log tail:\n${log}`);
      }
      return answer;
    };
    const bot = await create("/api/bots", { name: "Lead" });
    const group = await create("/api/groups", { name: "Project", memberIds: [bot.body.bot.id], channelProject: { goal: "Ship" } });
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
