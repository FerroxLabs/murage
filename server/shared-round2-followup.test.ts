// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import ts from "typescript";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR, loadConfig } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store, isIndividualAssistant } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { threadPartition, partitionRoots, isHomePartition, sameThreadPartition, partitionScopeKey } from "./execution-audience.ts";
import { partitionSessionAudience } from "./session-audience.ts";
import { partitionRoster } from "./shared-bots-roster.ts";
import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import { selectFileWorkspace, ensureWorkspace, loadMemory } from "./workspace.ts";
import { managedImageOutputPath } from "./output-publication.ts";
import { managedAudioOutputPath, createVoiceNote } from "./voice/voice-notes.ts";
import { publishImage } from "./image-operations.ts";
import { describeArtifact } from "./artifacts.ts";
import { installSkill, setSkillEnabled } from "./skills.ts";
import { createProcedurePin, readProcedureBundle } from "./procedure-bundles.ts";
import { backgroundMemoryAudience, reconcileMemoryRoster } from "./memory/policy.ts";
import { observeVerifiedHuman, linkHumanBinding, resolveHumanBinding, bindHumanThread } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { standingContextParts } from "./standing-context.ts";
import { partitionFileRefusal } from "./partition-files.ts";
import { autoVerdict } from "./auto-approve.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
function evaluate(code: string, deps: Record<string, unknown>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), js)(...Object.values(deps));
}
function declaration(name: string) {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(ast) === name) found ??= node;
    ts.forEachChild(node, visit);
  };
  visit(ast); if (!found) throw Error(`Missing ${name}`); return found;
}
function seam(name: string, deps: Record<string, unknown>) {
  const node = declaration(name);
  return evaluate(`${ts.isVariableDeclaration(node) ? "const " : ""}${node.getText(ast)}; return ${name};`, deps);
}
function value(name: string, deps: Record<string, unknown>) { return seam(name, deps); }
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const make = (name: string, section: string) => { const bot = store.createBot(); store.patchBot(bot.id, { name, section }); return bot; };
  const iris = make("Iris", "Design"), sam = make("Sam", "Sales");
  const sales = teamIdFor("Sales"); store.patchBot(sam.id, { chiefOfStaff: true });
  store.patchBot(iris.id, { sharedWith: { mode: "list", teams: [{ id: sales, name: "Sales" }] } });
  const work = store.createSharedWorkTask(iris.id, sales)!;
  const room = store.createGroup("Sales", [iris.id, sam.id], false, "Sales");
  return { store, iris, sam, sales, work, room };
}
function scopes(store: Store) { return seam("artifactScopes", { store, DATA_DIR, database, selectFileWorkspace, managedImageOutputPath, managedAudioOutputPath })(); }
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
it("R2.1/R2.7 publishImage and index artifactScopes use the Sales partition", () => {
  const f = fixture(), root = partitionRoots(f.iris, threadPartition(f.iris, f.work.threadId))[0];
  const image = publishImage(f.store, { botId: f.iris.id, threadId: f.work.threadId, generation: "gen", assertActive() {}, signal: new AbortController().signal }, { bytes: png, mime: "image/png" }, { provider: "openai", connectionId: "fixture", model: "fixture", operation: "generate", count: 1, referenceCount: 0 });
  // relative(): on Windows DATA_DIR is the lower-cased canonical spelling and
  // the published path keeps the file system's case; both name one folder.
  const placed = relative(join(root, "generated-images", f.work.threadId), image.path);
  expect(placed && !placed.startsWith("..") && !isAbsolute(placed), `${image.path} is not under ${join(root, "generated-images", f.work.threadId)}`).toBe(true);
  expect(image.filesError).toBeUndefined(); expect(image.artifactId).toBeTruthy();
  expect(describeArtifact(database(), join(DATA_DIR, "artifact-files"), image.artifactId!, { owner: true, scopes: scopes(f.store) }).sourceConversationAvailable).toBe(true);
  expect(existsSync(join(DATA_DIR, "workspaces", f.iris.id, "generated-images"))).toBe(false);
});
it("R2.1 voice publication and index artifactScopes use the Sales partition", async () => {
  const f = fixture(), root = partitionRoots(f.iris, threadPartition(f.iris, f.work.threadId))[0];
  const note = await createVoiceNote({ db: database(), dataDir: DATA_DIR, store: f.store, cfg: loadConfig(), speak: async () => ({ bytes: Buffer.from("fixture audio"), mime: "audio/mpeg" }) }, { botId: f.iris.id, threadId: f.work.threadId, runId: "gen", text: "Sales note" });
  expect(managedAudioOutputPath(DATA_DIR, f.iris.id, f.work.threadId)).toBe(join(root, "generated-audio", f.work.threadId));
  expect(describeArtifact(database(), join(DATA_DIR, "artifact-files"), note.artifact.id, { owner: true, scopes: scopes(f.store) }).sourceConversationAvailable).toBe(true);
  expect(existsSync(join(DATA_DIR, "workspaces", f.iris.id, "generated-audio"))).toBe(false);
});
it("R2.2 contact in a marked room cannot pin home learned skills", () => {
  const f = fixture();
  const bindingId = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "fixture", userId: "contact" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" }); bindHumanThread(f.room.threadId, resolveHumanBinding(bindingId));
  installSkill(f.iris.id, "learn:conversation", [{ path: "SKILL.md", content: "---\nname: private-method\ndescription: HOME_SKILL_CANARY\n---\n\nHOME_SKILL_CANARY" }]); setSkillEnabled(f.iris.id, "private-method", true);
  const audience = backgroundMemoryAudience(f.iris.id, f.room.threadId, f.store)!;
  expect(audience.audienceKey).toBe(`room:${f.room.id}:bot:${f.iris.id}`);
  const pin = createProcedurePin(f.iris.id, f.room.threadId, [], [], undefined, { audienceKey: audience.audienceKey, allowedScopeIds: audience.scopeIds });
  expect(readProcedureBundle(f.iris.id, f.room.threadId, pin).imported).toEqual([]);
});
it.each([false, true])("R2.3 index coordination preserves Chief tools (shared=%s)", shared => {
  const f = fixture(); f.iris.description = "HOME_PRIVATE_DESCRIPTION";
  if (!shared) { delete f.iris.partitionedAt; delete f.iris.sharedWith; }
  const chiefRoster = seam("chiefRoster", { store: f.store, database, withProjectNow: (bots: unknown) => bots, projectBotNowAnywhere: () => undefined, partitionRoster });
  const prompt = value("coordinationPrompt", { bot: f.sam, threadId: f.sam.threadId, store: f.store, surfacesForOwner: true, audienceRoster: partitionRoster(f.store, f.sam, f.sam.threadId, true), isHomePartition, threadPartition, chiefRoster, chiefOfStaffSystemPrompt, integrations: { agents: true }, openMurageStatusSystemPrompt: () => "STATUS_TOOLS_CANARY" });
  expect(prompt).toContain("Chief of Staff"); expect(prompt).toContain("delegate_bot"); expect(prompt).toContain("STATUS_TOOLS_CANARY");
  if (shared) { expect(prompt).toContain("Iris (shared): available"); expect(prompt).not.toContain("HOME_PRIVATE_DESCRIPTION"); }
});
it.each([false, true])("R2.4 session turns are read-only during a team journal (partitioned=%s)", partitioned => {
  const f = fixture(), bot = partitioned ? f.iris : f.sam;
  bot.section = "Unminted";
  database().prepare("UPDATE team_identities SET op='rename',op_phase=1,op_label='Revenue',op_records=? WHERE team_id=?").run(JSON.stringify({ bots: [], groups: [] }), f.sales);
  const before = database().prepare("SELECT * FROM team_identities").all();
  expect(partitionSessionAudience("owner", bot, bot.threadId)).toContain("home:Unminted:");
  expect(database().prepare("SELECT * FROM team_identities").all()).toEqual(before);
});
it.each(["team", "room", "isolated"])("R2.5 project identity wins over a %s marker across room and desks", kind => {
  const f = fixture(); f.room.partitionedFor = { [f.iris.id]: kind === "team" ? { kind, teamId: f.sales } : { kind: kind as "room" | "isolated" } };
  database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(f.room.id);
  const mine = f.store.ensureProjectDesk(f.iris.id, f.room.id, "Project")!, theirs = f.store.ensureProjectDesk(f.sam.id, f.room.id, "Project")!;
  const extra = f.store.createGroupTask(f.room.id, "Another thread", false)!;
  reconcileMemoryRoster(f.store); database().exec("UPDATE memory_meta SET mode='active'");
  const root = partitionRoots(f.iris, { kind: "project", groupId: f.room.id })[0];
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, "MEMORY.md"), "ONE_PROJECT_NOTEBOOK");
  for (const thread of [f.room.threadId, extra.threadId, mine.threadId, theirs.threadId]) {
    const p = threadPartition(f.iris, thread);
    expect(p).toEqual({ kind: "project", groupId: f.room.id, homeMember: false });
    expect(partitionScopeKey(f.iris.id, p)).toBe(`${f.iris.id}#project:${f.room.id}`);
    expect(loadMemory(f.iris.id, p)?.text).toBe("ONE_PROJECT_NOTEBOOK");
    expect(partitionRoots(f.iris, p)).toEqual(partitionRoots(f.iris, threadPartition(f.iris, mine.threadId)));
    expect(sameThreadPartition(f.iris, f.room.threadId, thread)).toBe(true);
  }
  for (const thread of [f.room.threadId, extra.threadId, mine.threadId]) {
    expect(backgroundMemoryAudience(f.iris.id, thread, f.store)?.audienceKey).toBe(`bot:${f.iris.id}:project:${f.room.id}:owner`);
  }
  // Same-project reading does not make another member's desk our execution context.
  expect(backgroundMemoryAudience(f.iris.id, theirs.threadId, f.store)).toBeNull();
});
it("R2.5 a marker keeps a home-space project member partitioned", () => {
  const f = fixture(), group = f.store.createGroup("Design", [f.iris.id], false, "Design"); group.partitionedFor = { [f.iris.id]: { kind: "room" } };
  database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(group.id);
  expect(threadPartition(f.iris, group.threadId)).toEqual({ kind: "project", groupId: group.id, homeMember: false });
  delete group.partitionedFor;
  expect(threadPartition(f.iris, group.threadId)).toEqual({ kind: "project", groupId: group.id, homeMember: true });
});
it("R2.6 unpartitioned agents retain inspect-only rows, individuals and project reach", () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const chief = store.createBot(), lead = store.createBot(), specialist = store.createBot(), solo = store.createBot();
  store.patchBot(chief.id, { chiefOfStaff: true, chiefScope: "workspace" }); store.patchBot(lead.id, { section: "Sales", chiefOfStaff: true }); store.patchBot(specialist.id, { section: "Sales" }); store.patchBot(solo.id, { section: "Solo", individual: true });
  const group = store.createGroup("Project", [chief.id], false, ""); database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(group.id);
  let route: ts.IfStatement | undefined;
  const visit = (node: ts.Node) => { if (ts.isIfStatement(node) && node.expression.getText(ast) === 'method === "GET" && path === "/api/internal/agents"') route = node; ts.forEachChild(node, visit); };
  visit(ast); expect(route).toBeDefined();
  const response = evaluate(`return (() => { ${route!.getText(ast)} })();`, { method: "GET", path: "/api/internal/agents", store, partitionRoster, internalClaim: { botId: chief.id, threadId: group.threadId }, url: new URL(`http://fixture/api/internal/agents?self=${chief.id}`), res: {}, json: (_res: unknown, status: number, body: unknown) => ({ status, body }), turnAudienceIsOwner: () => true, organizationRevision: () => "fixture" });
  expect(response.status).toBe(200);
  const roster: ReturnType<typeof partitionRoster> = response.body.bots;
  expect(roster.find(b => b.id === specialist.id)).toMatchObject({ reachable: false });
  expect(roster.find(b => b.id === lead.id)).toMatchObject({ reachable: true });
  expect(roster.find(b => b.id === solo.id)).toMatchObject({ individual: true }); expect(isIndividualAssistant(solo)).toBe(true);
});
it("R2.7 index standing prompt path selects Sales and excludes home notes", () => {
  const f = fixture(), root = partitionRoots(f.iris, threadPartition(f.iris, f.work.threadId))[0]; mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "MEMORY.md"), "SALES_NOTE"); writeFileSync(join(ensureWorkspace(f.iris.id), "MEMORY.md"), "HOME_NOTE");
  const standing = value("standing", { bot: f.iris, threadId: f.work.threadId, threadPartition, standingContextParts, surfacesForOwner: true, worksInWorkspace: false, opts: {}, fullAccessOrigin: "owner" });
  expect(standing.memory).toContain("SALES_NOTE"); expect(JSON.stringify(standing)).not.toContain("HOME_NOTE");
});
it("R2.7 real permission event denies cross-partition writes before Full access autoVerdict", () => {
  const f = fixture(); Object.assign(f.iris, { autoApprove: true, fullAccess: true, noLimits: true });
  const respondToRequest = vi.fn(), judged = vi.fn(autoVerdict);
  const fold = seam("foldRuntimeEvent", { accountProjectEvent: vi.fn(), shouldIgnoreProviderEvent: () => false, accountPresentedProjectEvent: () => true, presentedRequests: { publish: vi.fn() }, localVmThreadTargets: new Map(), groupGoalCoordinatorTurns: new Map(), groupGoalCoordinatorTurnForEvent: () => undefined, broadcast: vi.fn(), routines: null, store: f.store, botForDirectThread: () => f.iris, partitionFileRefusal, turnCwdByThread: new Map(), turnEngineByThread: new Map(), registry: { get: () => ({ adapter: { respondToRequest } }) }, autoVerdict: judged,
    // lane PF's reply speaker guard: not a project room here, so it guards nothing
    replyGuardContext: () => null, replySpeakerTurns: { started: vi.fn(), completed: vi.fn(), delta: vi.fn(), item: vi.fn(), removalRow: vi.fn() } });
  fold({ type: "request.opened", eventId: "event", threadId: f.work.threadId, requestId: "ask", requestType: "permission", tool: "write_file", filePaths: [join(DATA_DIR, "workspaces", f.iris.id, "MEMORY.md")] });
  expect(respondToRequest).toHaveBeenCalledWith(f.work.threadId, "ask", expect.objectContaining({ behavior: "deny" })); expect(judged).not.toHaveBeenCalled();
});
it("R2.7 / R4: the shared-load owner surface is served only where the owner roster and Team settings are", () => {
  const rosterSource = readFileSync(new URL("./shared-bots-roster.ts", import.meta.url), "utf8");
  const routes = readFileSync(new URL("./sharing-routes.ts", import.meta.url), "utf8");
  expect(rosterSource).toContain("function sharedLoadPrompt");
  expect(routes).toContain("sharedLoadPrompt(");
  // served by the owner's desktop routes: GET sharing (the owner roster line) and GET team-sections
  expect(source).toContain("sharingRoute(");
  expect(source).toContain("teamSharing(store, team.name, turnGenerationFor)");
});
it("R4: no Chief roster names the team a shared bot works for; shared-load stays on the owner's own surfaces", async () => {
  const f = fixture();
  const { withProjectNow } = await import("./project-roster.ts");
  const carl = f.store.createBot(); f.store.patchBot(carl.id, { name: "Carl", section: "Design", chiefOfStaff: true });
  const chiefRoster = seam("chiefRoster", { store: f.store, database, withProjectNow, projectBotNowAnywhere: () => "", partitionRoster });
  for (const roster of [chiefRoster(true, carl, carl.threadId), chiefRoster(true), chiefRoster(false, carl, carl.threadId), chiefRoster(true, f.sam, f.sam.threadId)])
    expect(JSON.stringify(roster)).not.toContain("working for Sales");
  const { sharedLoadLine } = await import("./sharing-routes.ts");
  expect(sharedLoadLine(f.iris, true, (threadId: string) => threadId === f.work.threadId ? "owner-generation" : undefined)).toBe("Iris, shared from Design: working for Sales, 0 waiting");
});
it("R2.7 wakeContinuationPrompt filters home results and keeps authorized Sales results", async () => {
  const f = fixture();
  const { insertRoomRequest, roomRequest, completeRequest } = await import("./room-requests.ts");
  const { continuationResultsForThread } = await import("./partition-sources.ts");
  const { requestSourceThread } = await import("./execution-audience.ts");
  const { continuationResultsPrompt } = await import("./project-prompt.ts");
  // Lane N: a close summary or lesson wake returns its own payload before any result is read; the real
  // receipt checks run here, and this plain continuation wake is neither.
  const { isProjectCloseRequest, isGoalCloseRequest } = await import("./project-close.ts");
  const { projectCardById, projectGoalById, projectSettingsFor } = await import("./project-records.ts");
  const { goalOpenCards, leadNextStep, projectTableExists } = await import("./project-turn-engine.ts");
  const make = (id: string, thread: string, text: string) => {
    const message = f.store.appendMessage(f.sam.threadId, { role: "bot", kind: "text", text });
    insertRoomRequest(database(), { id, admissionKey: id, groupId: f.room.id, fromKind: "bot", fromBotId: f.iris.id, toBotId: f.sam.id, targetThreadId: f.sam.threadId, verb: "ask", state: "running", now: 1,
      lineage: { rootThreadId: thread, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false, ...(thread === f.work.threadId ? { executionAudience: { v: 1, kind: "team", human: "owner", team: f.sales, rootRequestId: id } as const } : {}) } });
    completeRequest(database(), id, { state: "done", now: 2, resultMessageId: message.id }, {}, { continuation: false });
    return { requestId: id, botId: f.sam.id, messageId: message.id, state: "done" };
  };
  const results = [make("home-result", f.iris.threadId, "HOME_RESULT_CANARY"), make("sales-result", f.work.threadId, "SALES_RESULT_CANARY")];
  const wake = insertRoomRequest(database(), { id: "wake", admissionKey: "wake", groupId: f.room.id, fromKind: "murage", parentId: "sales-result", priority: "coordinator", toBotId: f.iris.id, targetThreadId: f.work.threadId, verb: "wake", payloadText: JSON.stringify(results), now: 2 }).request;
  const deps = { store: f.store, database, roomRequest, requestSourceThread, continuationResultsForThread, continuationResultsPrompt, roomRequestStillOwnerAudience: () => true,
    isProjectCloseRequest, isGoalCloseRequest, projectCardById, projectGoalById, projectSettingsFor, goalOpenCards, leadNextStep, projectTableExists };
  const prompt = seam("wakeContinuationPrompt", { ...deps, wakeRedirectText: seam("wakeRedirectText", {}), wakeGoalAction: seam("wakeGoalAction", {}) })(wake, f.work.threadId);
  expect(prompt).toContain("SALES_RESULT_CANARY"); expect(prompt).not.toContain("HOME_RESULT_CANARY");
});
