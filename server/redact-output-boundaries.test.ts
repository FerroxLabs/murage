import { openFixtureApproval } from "./testing/approval-card.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Slice 2B: actual historical/standalone bytes. Collector cases belong to 1B.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { Store } from "./store.ts";
import { ToolResults } from "./tool-results.ts";
import { initializeArtifacts, registerArtifact, describeArtifact } from "./artifacts.ts";
import { insertMemoryRecord } from "./memory/record-write.ts";
import { database } from "./database.ts";
import { reconcileMemoryRoster, ensureScope } from "./memory/policy.ts";
import { captureSource } from "./memory/capture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeAll(async () => { const { DATA_DIR } = await import("./config.ts"); mkdirSync(DATA_DIR, { recursive: true }); });

const markdown = "**password**: hunter2\nTAILSECRET";
const existing = ("api_key=OLDSECR" + "ET123456");
const noSecrets = (output: unknown) => expect(JSON.stringify(output)).not.toMatch(/hunter2|TAILSECRET|OLDSECRET123456|SIBLINGSECRET/);

// Engine failures are injected at the instance interface; the real route,
// owner proof, checkEngineReply and HTTP serialization all run unchanged.
describe.skipIf(process.platform === "win32")("standalone HTTP boundaries", () => {
  let fixture: VerificationServer;
  const checkRoot = mkdtempSync(join(tmpdir(), "l5a-check-"));
  let headers: Record<string, string>;
  let historical: { botId: string; threadId: string; messageId: string; cardId: string };
  const registryUrl = pathToFileURL(join(process.cwd(), "server/harness/registry.ts")).href;
  const checkUrl = pathToFileURL(join(process.cwd(), "server/engine-reply-check.ts")).href;
  const cases = [
    `rate limit ${markdown}`,
    ("rate limit **password**: -----BEGIN PRIVATE " + "KEY-----\nhunter2\n-----END PRIVATE " + "KEY-----\nTAILSECRET"),
    "rate limit **password**: token = sk-abcdefghijklmnop\nhunter2\nTAILSECRET",
  ];
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const {Store} = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/store.ts")).href)});
      const {appendFixtureDbMessage} = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/approval-card.ts")).href)});
      const store = new Store(() => ({ instanceId: 'fixture', model: 'fixture-model' }));
      const bot = store.createBot({}, {seedMessages:false});
      store.stopSeqStamps();
      const {Server} = await import('node:http');
      const {writeFileSync} = await import('node:fs');
      const {join} = await import('node:path');
      const listen = Server.prototype.listen;
      Server.prototype.listen = function(...args) {
        if (args[0] === Number(process.env.MURAGE_PORT)) this.once('listening', () => {
          // MAIN RULING INT-CONFLICT-DEFAULT d80958bbeb 3ad2b8f428: seed authorized legacy bytes after recovery; no engine approval survives a restart.
          const message = {id:'historical-message',at:Date.now(),role:'bot',kind:'text',text:${JSON.stringify(existing)}};
          const card = {id:'historical-card',at:Date.now(),parentId:message.id,role:'bot',kind:'options',text:${JSON.stringify(existing)},card:{title:${JSON.stringify(existing)},subtitle:'SIBLINGSECRET',options:[],answerAsSend:true,requestId:'old-ask',questions:[{id:'provider-question',question:'Question',options:[{label:'one'}],allowOther:true}]}};
          appendFixtureDbMessage(bot.threadId, message);
          appendFixtureDbMessage(bot.threadId, card);
          writeFileSync(join(process.env.MURAGE_DATA_DIR,'historical.json'),JSON.stringify({botId:bot.id,threadId:bot.threadId,messageId:message.id,cardId:card.id}));
        });
        return listen.apply(this,args);
      };
      const {ProviderRegistry} = await import(${JSON.stringify(registryUrl)});
      const {engineCheckHost} = await import(${JSON.stringify(checkUrl)});
      const fs = await import('node:fs'); const path = await import('node:path'); const os = await import('node:os');
      engineCheckHost.systemRoot = () => ${JSON.stringify(checkRoot)};
      const original = ProviderRegistry.prototype.get;
      const cases = ${JSON.stringify(cases)};
      ProviderRegistry.prototype.get = function(id) {
        if (/^redact-[0-2]$/.test(id)) return { instanceId: id, displayName: 'Fixture', checkReply: async () => { throw Object.assign(new Error('failed'), {engineLine: cases[Number(id.slice(-1))]}); } };
        return original.call(this, id);
      };
    ` });
    historical = JSON.parse(readFileSync(join(fixture.info.dataDir, "historical.json"), "utf8"));
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30_000);
  afterAll(async () => { await fixture?.close(); removeTempDirSync(checkRoot); });
  const get = async (path: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, { headers });
    expect(response.status).toBe(200);
    return response.json() as Promise<Record<string, any>>;
  };
  it.each(["paginated", "unpaginated", "branch", "window", "openCards"])("historical.messages.http.%s", async mode => {
    const { threadId, messageId, cardId } = historical;
    const path = mode === "unpaginated" ? "/api/bots" : mode === "openCards" ? `/api/threads/${threadId}/open-cards`
      : `/api/threads/${threadId}/messages?${mode === "branch" ? `branchFrom=${cardId}` : mode === "window" ? `around=${messageId}` : "limit=100"}`;
    const body = await get(path);
    noSecrets(body);
    expect(JSON.stringify(body)).toContain(mode === "openCards" ? cardId : messageId);
  });
  it("historical.message.http.post-and-delta", async () => {
    const { threadId, messageId } = historical;
    const before = await get(`/api/threads/${threadId}/messages?view=switch&limit=100`);
    const response = await fetch(`${fixture.info.url}/api/threads/${threadId}/messages/${messageId}/reactions`, { method: "POST", headers, body: JSON.stringify({ emoji: "👍" }) });
    expect(response.status).toBe(200);
    const post = await response.json(); noSecrets(post);
    expect((post as any).message.id).toBe(messageId);
    const delta = await get(`/api/threads/${threadId}/messages?view=switch&since=${encodeURIComponent(before.version)}&limit=100`);
    expect(delta.delta).toBe(true); noSecrets(delta);
    expect(delta.messages.some((row: any) => row.id === messageId)).toBe(true);
  });
  it("historical.message.http.frame-and-reconnect", async () => {
    const control = new AbortController();
    const stream = await fetch(`${fixture.info.url}/api/events`, { headers, signal: control.signal });
    const reader = stream.body!.getReader(), decoder = new TextDecoder();
    const deadline = setTimeout(() => control.abort(), 10_000);
    let text = "";
    try {
      while (!text.includes('"kind":"hello"')) text += decoder.decode((await reader.read()).value);
      const cursor = JSON.parse(text.split("\n").find(line => line.startsWith("data: "))!.slice(6)).cursor;
      await fetch(`${fixture.info.url}/api/threads/${historical.threadId}/messages/${historical.messageId}/reactions`, { method: "POST", headers, body: JSON.stringify({ emoji: "✅" }) });
      while (!text.includes('"kind":"message.patch"')) text += decoder.decode((await reader.read()).value);
      noSecrets(text);
      control.abort();
      const reconnect = new AbortController();
      const resumed = await fetch(`${fixture.info.url}/api/events`, { headers: { ...headers, "last-event-id": cursor }, signal: reconnect.signal });
      const replay = resumed.body!.getReader(); let bytes = "";
      const timeout = setTimeout(() => reconnect.abort(), 10_000);
      try {
        while (!bytes.includes('"kind":"message.patch"')) bytes += decoder.decode((await replay.read()).value);
        noSecrets(bytes); expect(bytes).toContain(historical.messageId);
      } finally { clearTimeout(timeout); reconnect.abort(); await replay.cancel().catch(() => {}); }
    } finally { clearTimeout(deadline); control.abort(); await reader.cancel().catch(() => {}); }
  });
  it.each(cases.map((_, i) => i))("serialized.engine-setup-check.%i", async i => {
    const response = await fetch(`${fixture.info.url}/api/engine-setup-check`, { method: "POST", headers, body: JSON.stringify({ instanceId: `redact-${i}` }) });
    expect(response.status).toBe(200);
    const text = await response.text();
    noSecrets(text);
    expect(JSON.parse(text).result).toBe("limit");
    expect(text).toContain("redacted");
  });
});

describe("standalone storage and model result boundaries", () => {
  it("serialized.store-append / serialized.cross-field-card", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot();
    const input = { role: "bot" as const, kind: "activity" as const, text: "SIBLINGSECRET", tool: { name: "read", summary: existing, spoken: "SIBLINGSECRET" } };
    const before = JSON.stringify(input);
    const row = store.appendMessage(bot.threadId, input);
    noSecrets(row);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([existing, markdown])("serialized.model-tool-result %s", text => {
    const results = new ToolResults(), owner = { botId: "bot", threadId: "thread" };
    const saved = results.save(owner, text + "x".repeat(130_000));
    noSecrets(results.read(owner, saved.id, 0));
    expect(results.read({ ...owner, threadId: "other" }, saved.id, 0)).toBeNull();
  });
  it.each([existing, markdown])("serialized.memory-record-write %s", text => {
    const db = database(), scopeId = ensureScope("bot", "redact-bot");
    const id = `record-${Math.random()}`;
    insertMemoryRecord(db, { id, version: 1, scopeId, kind: "fact", text, assertion: "owner-statement", state: "active", validFrom: 1, createdAt: 1 });
    noSecrets(db.prepare("SELECT text FROM memory_records WHERE id=?").get(id));
  });
  it("serialized.memory-capture.cross-field", () => {
    reconcileMemoryRoster({ bots: [{ id: "capture-bot", threadId: "capture-thread" }], groups: [] });
    const db = database();
    const source = { id: "redact-source", threadId: "capture-thread", kind: "tool-outcome", speaker: "tool", outcome: "completed", text: existing,
      action: { label: "SIBLINGSECRET", detail: "SIBLINGSECRET", reportedOutcome: "completed" as const, verification: "tool-reported" as const } };
    const before = JSON.stringify(source);
    captureSource(db, source);
    const rows = db.prepare("SELECT payload FROM memory_source_versions WHERE source_id=?").all(source.id);
    expect(rows).toHaveLength(1);
    noSecrets(rows);
    expect(JSON.stringify(source)).toBe(before);
  });
  it("serialized.artifact-metadata and execution.artifact-source.unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "l5a-artifact-"));
    const db = new DatabaseSync(":memory:");
    try {
      const workspace = join(root, "workspace"), storage = join(root, "saved");
      mkdirSync(workspace); mkdirSync(join(workspace, existing)); writeFileSync(join(workspace, existing, "report.txt"), markdown);
      initializeArtifacts(db);
      const access = { owner: true, scopes: [{ botId: "bot", botName: "SIBLINGSECRET", threadId: "thread", workspaceRoot: workspace }] };
      const saved = registerArtifact(db, storage, { botId: "bot", threadId: "thread", relativePath: `${existing}/report.txt`, name: existing }, access);
      // Simulate an older stored title, bypassing today's registration scrub.
      db.prepare("UPDATE artifacts SET name=? WHERE id=?").run(existing, saved.id);
      noSecrets(describeArtifact(db, storage, saved.id, access));
      expect(readFileSync(join(workspace, existing, "report.txt"), "utf8")).toBe(markdown);
    } finally { db.close(); removeTempDirSync(root); }
  });
});

// Standalone exits use real stores and serializers. The shared rule's new
// Markdown cases above also run on the combined 2A/2B head; these cases isolate
// boundary/order behavior with a secret the frozen base already recognizes.
describe("standalone sink inventory fixtures", () => {
  it("serialized.inbox", async () => {
    const { initializeInbox, listInbox } = await import("./inbox.ts");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id))");
      initializeInbox(db);
      const row = { id: "card", at: 100, role: "bot", kind: "options", card: { requestId: "request", title: existing, subtitle: "SIBLINGSECRET", tool: "Bash", options: ["Allow", "Deny"] } };
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("thread", "card", 100, "bot", "options", null, JSON.stringify(row));
      const before = db.prepare("SELECT json FROM messages").get();
      const page = listInbox(db, {}, { owner: true, threads: [{ threadId: "thread", label: "Bot", botId: "bot" }] });
      expect(page.items).toHaveLength(1); noSecrets(page);
      expect(page.items[0].link).toMatchObject({ threadId: "thread", messageId: "card" });
      expect(db.prepare("SELECT json FROM messages").get()).toEqual(before);
    } finally { db.close(); }
  });
  it("serialized.memory-authority and execution.memory-authority.unchanged", async () => {
    const { ownerMemoryTicket, rememberMemory } = await import("./memory/authority.ts");
    const input = { actionId: "l5a-remember", text: `Project uses ${existing}` };
    expect(() => rememberMemory({}, input)).toThrow("MEMORY_OWNER_REQUIRED");
    const saved = rememberMemory(ownerMemoryTicket(), input);
    noSecrets(database().prepare("SELECT text FROM memory_records WHERE id=?").get(saved.id));
    expect(input.text).toContain(("OLDSECR" + "ET123456"));
  });
  it("serialized.memory-import and execution.memory-source.unchanged", async () => {
    const { ownerMemoryTicket } = await import("./memory/authority.ts");
    const { previewMemoryImport, commitMemoryImport } = await import("./memory/import.ts");
    const { DATA_DIR } = await import("./config.ts");
    const roster = { bots: [{ id: "import-bot", threadId: "import-thread", section: "Secret boundary" }], groups: [] };
    reconcileMemoryRoster(roster);
    const file = join(DATA_DIR, "section-contexts.json"), original = JSON.stringify({ version: 1, contexts: { "Secret boundary": { text: existing } } });
    writeFileSync(file, original);
    const owner = ownerMemoryTicket(), preview = previewMemoryImport(owner, [{ kind: "section", section: "Secret boundary" }], roster);
    expect(preview.items).toHaveLength(1); noSecrets(preview);
    noSecrets(commitMemoryImport(owner, preview.previewId, roster));
    expect(readFileSync(file, "utf8")).toBe(original);
  });
  it("serialized.memory-identity", async () => {
    const { ownerMemoryTicket } = await import("./memory/authority.ts");
    const { writeBotIdentity, readBotIdentity } = await import("./memory/identity.ts");
    const roster = { bots: [{ id: "identity-bot", threadId: "identity-thread" }], groups: [] };
    reconcileMemoryRoster(roster);
    const owner = ownerMemoryTicket();
    const saved = writeBotIdentity(owner, { action: "identity-write", botId: "identity-bot", kind: "continuity-brief", key: "core", expectedVersion: 0, text: `Fiction: ${existing}`, basis: "fiction", audience: "owner-private" }, roster);
    noSecrets(saved); noSecrets(readBotIdentity(owner, "identity-bot", roster));
  });
  it("serialized.memory-pip-reflect", async () => {
    const { supportCopy } = await import("./memory/pip-reflect.ts");
    const line = supportCopy({ status: "unsupported", reason: `inspection-failed ${existing}`, at: 1 }, "SIBLINGSECRET");
    expect(line).toContain("Reflection needs"); noSecrets(line);
  });
  it("serialized.memory-feedback", async () => {
    const { decideFeedback } = await import("./memory/feedback.ts");
    const output = await decideFeedback({ text: `No, use ${existing} instead.`, turn: null, replied: true, now: 1, at: 1, classifier: null });
    expect(output.kind).toBe("feedback"); noSecrets(output);
  });
  it("serialized.memory-outcomes", async () => {
    const { MEMORY_SCHEMA } = await import("./memory/schema.ts");
    const { markOutcome, captureApprovalDecision } = await import("./memory/outcomes.ts");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(MEMORY_SCHEMA);
      db.exec("INSERT INTO memory_meta(id,schema_version,installation_id,mode) VALUES(1,13,'test','active')");
      db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id))");
      db.prepare("INSERT INTO messages VALUES('thread','message',1,'bot','text','answer',?)").run(JSON.stringify({ id: "message", role: "bot", kind: "text", text: "answer", at: 1 }));
      noSecrets(markOutcome(db, { botId: "bot", threadId: "thread", messageId: "message", kind: "won", reason: existing, now: 2 }));
      captureApprovalDecision(db, { botId: "bot", threadId: "thread", requestId: "request", tool: existing, approved: false, now: 3 }, { id: "bot", learning: { enabled: true, askFirst: false, prospectLearning: false, revision: 0 } });
      noSecrets(db.prepare("SELECT target_action,correction FROM memory_feedback").all());
    } finally { db.close(); }
  });
});

it("serialized.memory-review.sources-before-truncation", async () => {
  const { ownerMemoryTicket } = await import("./memory/authority.ts");
  const { reviewSources } = await import("./memory/review.ts");
  const roster = { bots: [{ id: "review-bot", threadId: "review-thread", name: "Review" }], groups: [] };
  reconcileMemoryRoster(roster);
  const db = database(), text = `${existing}\n${"ordinary ".repeat(80)}`;
  captureSource(db, { id: "review-source", threadId: "review-thread", kind: "message", speaker: "owner", outcome: "observed", text: "old placeholder" });
  db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='review-source'").run(JSON.stringify({ text }));
  insertMemoryRecord(db, { id: "review-record", version: 1, scopeId: ensureScope("bot", "review-bot"), kind: "fact", text: "Candidate", assertion: "assistant-inference", state: "candidate", validFrom: 1, createdAt: 1 });
  db.prepare("INSERT INTO memory_evidence VALUES('review-record',1,'review-source',1,0,?)").run(Buffer.byteLength(text));
  const before = db.prepare("SELECT payload FROM memory_source_versions WHERE source_id='review-source'").get();
  const output = reviewSources(ownerMemoryTicket(), roster, { id: "review-record", version: 1 });
  expect(output.sources).toHaveLength(1); noSecrets(output);
  expect(output.sources[0].excerpt.length).toBeLessThanOrEqual(400);
  expect(db.prepare("SELECT payload FROM memory_source_versions WHERE source_id='review-source'").get()).toEqual(before);
});

it("serialized.memory-inspect.legacy-quote-original-unchanged", async () => {
  const { ownerMemoryTicket } = await import("./memory/authority.ts");
  const { memoryOwnerRoute } = await import("./memory/settings.ts");
  const roster = { bots: [{ id: "inspect-bot", threadId: "inspect-thread" }], groups: [] };
  reconcileMemoryRoster(roster);
  const db = database();
  captureSource(db, { id: "inspect-source", threadId: "inspect-thread", kind: "message", speaker: "owner", outcome: "observed", text: "old placeholder" });
  // A historical evidence payload predates the write-time credential mask.
  const payload = JSON.stringify({ text: markdown });
  db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='inspect-source'").run(payload);
  insertMemoryRecord(db, { id: "inspect-record", version: 1, scopeId: ensureScope("bot", "inspect-bot"), kind: "fact", text: "Candidate", assertion: "assistant-inference", state: "candidate", validFrom: 1, createdAt: 1 });
  db.prepare("INSERT INTO memory_evidence VALUES('inspect-record',1,'inspect-source',1,0,?)").run(Buffer.byteLength(markdown));
  const output = await memoryOwnerRoute("/api/memory/action", { action: "inspect", id: "inspect-record", version: 1 }, ownerMemoryTicket(), roster) as { evidence: Array<{ text: string }> };
  expect(output.evidence).toHaveLength(1);
  expect(output.evidence[0].text).toContain("redacted");
  noSecrets(output);
  expect(db.prepare("SELECT payload FROM memory_source_versions WHERE source_id='inspect-source'").get()?.payload).toBe(payload);
});

it("serialized.memory-identity.reveal-json", async () => {
  const { ownerMemoryTicket } = await import("./memory/authority.ts");
  const { writeBotIdentity, readBotIdentity } = await import("./memory/identity.ts");
  const roster = { bots: [{ id: "reveal-bot", threadId: "reveal-thread" }], groups: [] };
  reconcileMemoryRoster(roster);
  const owner = ownerMemoryTicket();
  const canon = writeBotIdentity(owner, { action: "identity-write", botId: "reveal-bot", kind: "character-canon", key: "canon", expectedVersion: 0, text: "Fictional lighthouse", basis: "fiction", audience: "owner-private" }, roster);
  const input = { action: "identity-write" as const, botId: "reveal-bot", kind: "reveal-state" as const, key: "state", expectedVersion: 0, text: markdown, basis: "fiction" as const, audience: "owner-private" as const, canon: { id: canon.id, version: canon.version }, revealed: false };
  const saved = writeBotIdentity(owner, input, roster);
  const row = readBotIdentity(owner, "reveal-bot", roster).records.find(row => row.id === saved.id)!;
  expect(JSON.parse(String(row.text))).toMatchObject({ canonId: canon.id, audience: "owner-private", revealed: false });
  noSecrets(row); expect(input.text).toBe(markdown);
});

it("serialized.store-patch and execution.store-original-approval.unchanged", () => {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" })), bot = store.createBot();
  const questions = [{ id: "provider-question", question: "Choose", multiSelect: false, allowOther: true, options: [{ label: "exact provider option" }], secret: true }];
  const original = { role: "bot" as const, kind: "options" as const, card: { title: "Choose", subtitle: "Choose", options: [], requestId: "original-provider-request", exactAllowKey: "original-execution-key", questions } };
  const authorized = openFixtureApproval(database(), bot.threadId, { ...original, id: 'l5a-original-approval' });
  const { id, ...input } = authorized;
  let row = store.appendMessage(bot.threadId, input, id);
  expect(() => store.patchMessage(bot.threadId, row.id, { card: { ...row.card!, title: existing } })).toThrow();
  database().prepare("UPDATE approval_records SET state='answered',delivery='accepted',settled_at=1 WHERE chat_message_id=?").run(id);
  row = store.patchMessage(bot.threadId, id, { card: { ...row.card!, answered: 'deny' } })!;
  const patched = store.patchMessage(bot.threadId, row.id, { text: "SIBLINGSECRET", card: { ...row.card!, title: existing, subtitle: "SIBLINGSECRET" } });
  expect(patched).toBeTruthy(); noSecrets(patched);
  expect(patched!.card).toMatchObject({ requestId: "original-provider-request", exactAllowKey: "original-execution-key", questions });
  expect(store.messageById(bot.threadId, row.id)?.card?.questions).toEqual(questions);
  expect(original.card.title).toBe("Choose");
});


it("serialized.routine-output / serialized.routine-error / execution.routine-input.unchanged", async () => {
  const { RoutineManager } = await import("./routines.ts");
  const dir = mkdtempSync(join(tmpdir(), "l5a-routine-"));
  const sent: string[] = [], emitted: unknown[] = [];
  const manager = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "routine-thread" }), startTurn: async (_bot, _thread, text) => { sent.push(text); }, interruptTurn: async () => {}, emit: frame => { if (frame.kind === "routine.run") emitted.push(frame); } });
  try {
    const prompt = "Read the original file.\nKeep its bytes: α β.";
    const routine = manager.create({ name: "Fixture", prompt, botId: "bot", target: "bot", runOn: "ember", enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() } });
    manager.runNow(routine.id);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toBe(prompt);
    manager.handleRuntimeEvent({ type: "turn.started", threadId: "routine-thread", turnId: "routine-turn" } as never);
    manager.handleRuntimeEvent({ type: "item.completed", threadId: "routine-thread", turnId: "routine-turn", itemType: "assistant_text", text: existing } as never);
    manager.handleRuntimeEvent({ type: "runtime.error", threadId: "routine-thread", turnId: "routine-turn", message: existing } as never);
    expect(emitted.length).toBeGreaterThan(0); noSecrets(emitted);
    expect(manager.listRuns()[0].output).toContain("redacted");
    expect(manager.listRuns()[0].error).toContain("redacted");
    const persisted = readFileSync(join(dir, "routines.json"), "utf8");
    noSecrets(persisted);
  } finally { manager.stop(); removeTempDirSync(dir); }
});

it("serialized.memory-bring-in.order-and-original", async () => {
  const { bringInToProject, BRING_IN_MAX_CHARS } = await import("./memory/bring-in.ts");
  const redaction = await import("./redact.ts");
  const { appendMessage } = await import("./message-db.ts");
  const roster = { bots: [{ id: "bring-bot", threadId: "bring-thread" }], groups: [{ id: "bring-room", threadId: "bring-room-thread", memberIds: ["bring-bot"] }] };
  reconcileMemoryRoster(roster);
  const original = `${"ordinary ".repeat(150)}${existing}`;
  appendMessage("bring-thread", { id: "bring-message", at: 1, role: "user", kind: "text", origin: "desktop", text: original });
  const db = database(), before = db.prepare("SELECT text FROM messages WHERE id='bring-message'").get();
  const spy = vi.spyOn(redaction, "redactSecretsInText");
  try {
    const result = bringInToProject(db, { groupId: "bring-room", roomThreadId: "bring-room-thread", botId: "bring-bot", roster, now: Date.now(), sourceMessageId: "bring-message", threadId: "bring-thread" });
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(original);
    if (result.ok) {
      const row = db.prepare("SELECT text FROM memory_records WHERE id=?").get(result.recordId)!;
      expect(String(row.text).length).toBeLessThanOrEqual(BRING_IN_MAX_CHARS); noSecrets(row);
    }
    expect(db.prepare("SELECT text FROM messages WHERE id='bring-message'").get()).toEqual(before);
  } finally { spy.mockRestore(); }
});

it("serialized.memory-consolidate", async () => {
  const { appendMessage } = await import("./message-db.ts");
  const { claimMemoryJob, publishMemoryWork } = await import("./memory/jobs.ts");
  const { captureWork } = await import("./memory/chunks.ts");
  const { refreshMemoryCheckpoint } = await import("./memory/consolidate.ts");
  const roster = { bots: [{ id: "consolidate-bot", threadId: "consolidate-thread" }], groups: [] };
  reconcileMemoryRoster(roster);
  appendMessage("consolidate-thread", { id: "consolidate-message", at: 1, role: "user", kind: "text", origin: "desktop", text: existing });
  let work, completed: string | undefined;
  while ((work = claimMemoryJob("l5a-fixture"))) {
    publishMemoryWork(work, "l5a-fixture", captureWork(work));
    if (work.sourceId === "message:consolidate-thread:consolidate-message") completed = work.id;
  }
  expect(completed).toBeTruthy();
  const output = refreshMemoryCheckpoint(completed!);
  expect(output.status).not.toBe("deferred");
  const rows = database().prepare("SELECT text FROM memory_records WHERE kind='checkpoint' AND scope_id=?").all(ensureScope("conversation", "consolidate-thread"));
  expect(rows.length).toBeGreaterThan(0); noSecrets(rows);
});

// Execute the actual index.ts sink expressions with isolated transport/store
// dependencies. This avoids starting Slack/Discord/Telegram or delivering a
// notification to a real account. The source expression, redactor and channel
// formatter are production code; assertions inspect their serialized output.
describe("index standalone sink sites", () => {
  let ts: typeof import("typescript"), source: import("typescript").SourceFile;
  beforeAll(async () => {
    ts = await import("typescript");
    source = ts.createSourceFile("index.ts", readFileSync(join(process.cwd(), "server/index.ts"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  });
  const collect = (test: (node: import("typescript").Node) => boolean) => {
    const found: import("typescript").Node[] = [];
    const visit = (node: import("typescript").Node) => { if (test(node)) found.push(node); ts.forEachChild(node, visit); };
    visit(source); return found;
  };
  const execute = (code: string, bindings: Record<string, unknown>) => {
    const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
  };
  const bindings = async () => ({ ...await import("./redact.ts"), ...await import("./transcript-page.ts") });
  it.each([15436, 15491, 15552, 15634, 17967])("serialized.channel-%i", async site => {
    const { channelReplyText } = await import("./draft-only.ts");
    const nodes = collect(node => ts.isReturnStatement(node) && Boolean(node.expression?.getText(source).startsWith("run ? { status: run.status, output: channelReplyText")));
    expect(nodes).toHaveLength(5);
    const node = nodes[[15436, 15491, 15552, 15634, 17967].indexOf(site)] as import("typescript").ReturnStatement;
    const run = { status: "completed", botId: "bot", output: markdown, error: markdown };
    const original = JSON.stringify(run);
    const result = execute(`return ${node.expression!.getText(source)};`, { ...await bindings(), run, store: { bot: () => ({ id: "bot", name: "Fixture" }) }, channelReplyText, channelLimitNotice: () => undefined, appToken: "fixture-app-token", botToken: "fixture-bot-token" });
    noSecrets(JSON.stringify(result)); expect(JSON.stringify(run)).toBe(original);
  });
  it.each([
    [10135, "turn.retrying thread="], [10153, "runtime.error thread="], [10321, "[output-publication]"], [14966, "[routines] a run's result"],
    [20246, "could not get ready in"], [20248, "back after a failed setup"], [28097, "[setup-brief]"],
  ] as const)("serialized.console-%i", async (_site, marker) => {
    const nodes = collect(node => ts.isCallExpression(node) && /^console\.(info|warn|error)$/.test(node.expression.getText(source)) && node.getText(source).includes(marker));
    expect(nodes).toHaveLength(1);
    const output: unknown[][] = [];
    const event = { threadId: "host-thread", attempt: 0, delayMs: 10, reason: markdown };
    execute(marker === "runtime.error thread=" && ts.isBlock(nodes[0].parent.parent) ? nodes[0].parent.parent.getText(source) : nodes[0].getText(source), { ...await bindings(), console: { info: (...args: unknown[]) => output.push(args), warn: (...args: unknown[]) => output.push(args), error: (...args: unknown[]) => output.push(args) }, event, audienceMasked: false, bot: { id: "host-bot" }, threadId: "host-thread", raw: markdown, error: new Error(markdown), releaseError: new Error(markdown), providerError: { engine: "fixture", kind: "limit", httpStatus: 429, providerSaid: markdown, providerTeam: "SIBLINGSECRET" } });
    expect(output).toHaveLength(1); noSecrets(output);
  });
  it.each([5744, 5810])("serialized.notification-%i.goal-card", async site => {
    const name = site === 5744 ? "finishGroupGoalRun" : "updateGroupGoalRunProgress";
    const functions = collect(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    expect(functions).toHaveLength(1);
    const output: unknown[] = [];
    const operation = { threadId: "host-thread", goalRun: { runId: "host-run", cardMessageId: "host-card", goal: "SIBLINGSECRET", coordinatorName: "SIBLINGSECRET", coordinatorBotId: "host-bot", turnCount: 1, maxTurns: 3, startedAt: 1 } };
    execute(`${functions[0].getText(source)}; ${name}(${site === 5744 ? '"host-group", operation, "completed", detail' : 'operation, detail'});`, { ...await bindings(), operation, detail: markdown, routines: undefined, store: { group: () => ({ dm: true, threadId: "host-thread" }), messageById: () => undefined, patchMessage: (_thread: string, _id: string, patch: unknown) => output.push(patch) } });
    expect(output).toHaveLength(1); noSecrets(output);
    expect(JSON.stringify(output)).toContain("host-run");
  });
  it("serialized.notification-14581.before-summary-and-click-unchanged", async () => {
    const { buildNotification: buildRawNotification } = await import("./notify.ts");
    const functions = collect(node => ts.isFunctionDeclaration(node) && node.name?.text === "buildNotification");
    const bot = { id: "host-bot", name: "SIBLINGSECRET" };
    const extra = { messageId: "host-message", requestId: "host-request" };
    const code = functions.length ? `${functions[0].getText(source)}; return buildNotification("turn-failed", bot, "host-thread", detail, extra);` : 'return buildRawNotification("turn-failed", bot, "host-thread", detail, extra);';
    const result = execute(code, { ...await bindings(), buildRawNotification, bot, detail: markdown, extra });
    noSecrets(result); expect(result).toMatchObject({ botId: "host-bot", threadId: "host-thread", messageId: "host-message", requestId: "host-request" });
  });
  it("serialized.notification-14735.incident-detail", async () => {
    const declarations = collect(node => ts.isVariableDeclaration(node) && node.name.getText(source) === "incident" && node.initializer?.getText(source).includes("redactSecretsInText(input.detail)") === true) as import("typescript").VariableDeclaration[];
    expect(declarations).toHaveLength(1);
    const result = execute(`return ${declarations[0].initializer!.getText(source)};`, { ...await bindings(), input: { detail: markdown }, bot: { id: "host-bot", name: "Fixture" }, threadId: "host-thread", task: null, group: null, teamIncidentContext: () => ({ lastRequest: null, lastReply: null }) });
    noSecrets(result); expect(result).toMatchObject({ threadId: "host-thread", bot: { id: "host-bot" } });
  });
});

it("serialized.pi-error", async () => {
  const { piToolErrorDetail } = await import("./drivers/pi.ts");
  const input = { result: markdown };
  noSecrets(piToolErrorDetail(input)); expect(input.result).toBe(markdown);
});
it.each([2388, 4616, 4773])("serialized.acp-notice-%i", async site => {
  const ts = await import("typescript"), { redactSecretsInText } = await import("./redact.ts"), { stripVTControlCharacters } = await import("node:util");
  const { toolFailureText } = await import("../shared/tool-activity.ts");
  const file = ts.createSourceFile("core.ts", readFileSync(join(process.cwd(), "server/drivers/acp/core.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  let expression: import("typescript").Node | undefined;
  const walk = (node: import("typescript").Node) => {
    const text = node.getText(file);
    if (site === 2388 && ts.isCallExpression(node) && node.expression.getText(file) === "proc.owner.hooks.notice" && text.includes("redactSecretsInText")) expression = node;
    if (site === 4616 && ts.isVariableDeclaration(node) && node.name.getText(file) === "detail" && node.initializer?.getText(file).includes('u.status === "failed" ? redactSecretsInText(toolFailureText(u)')) expression = node.initializer;
    if (site === 4773 && ts.isVariableDeclaration(node) && node.name.getText(file) === "diagnostic" && node.initializer?.getText(file) === "redactSecretsInText(stripVTControlCharacters(captured))") expression = node.initializer;
    ts.forEachChild(node, walk);
  };
  walk(file); expect(expression).toBeTruthy();
  const output: unknown[] = [], proc = { owner: { hooks: { notice: (text: string) => output.push(text) } } };
  const code = ts.transpileModule(`return ${expression!.getText(file)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const result = new Function("redactSecretsInText", "stripVTControlCharacters", "toolFailureText", "proc", "line", "captured", "u", code)(redactSecretsInText, stripVTControlCharacters, toolFailureText, proc, `Fuigo: ${markdown}`, markdown, { status: "failed", content: [{ type: "text", text: markdown }] });
  if (site !== 2388) output.push(result);
  expect(output).toHaveLength(1); expect(output[0]).toBeTruthy(); noSecrets(output);
});

it("serialized.memory-reveal and execution.memory-policy.unchanged", async () => {
  const { ownerMemoryTicket } = await import("./memory/authority.ts");
  const { writeBotIdentity, readBotIdentity } = await import("./memory/identity.ts");
  const { appendMessage } = await import("./message-db.ts");
  const { claimMemoryJob, publishMemoryWork } = await import("./memory/jobs.ts");
  const { captureWork } = await import("./memory/chunks.ts");
  const { captureBotReveals } = await import("./memory/reveal-capture.ts");
  const roster = { bots: [{ id: "capture-reveal-bot", threadId: "capture-reveal-thread" }], groups: [] };
  reconcileMemoryRoster(roster);
  const owner = ownerMemoryTicket(), text = "Fiction: I tended the lighthouse.";
  writeBotIdentity(owner, { action: "identity-write", botId: "capture-reveal-bot", kind: "character-canon", key: "canon", expectedVersion: 0, text, basis: "fiction", audience: "owner-private" }, roster);
  appendMessage("capture-reveal-thread", { id: "capture-reveal-message", at: 1, role: "bot", kind: "text", text: `${text}\n${markdown}`, turnId: "host-turn", turnTerminal: true });
  let work, completed: string | undefined;
  while ((work = claimMemoryJob("l5a-fixture"))) {
    publishMemoryWork(work, "l5a-fixture", captureWork(work));
    if (work.sourceId === "message:capture-reveal-thread:capture-reveal-message") completed = work.id;
  }
  expect(completed).toBeTruthy();
  const extractor = Object.assign(async () => "[]", { ground: async () => JSON.stringify({ supported: true }) }) as import("./memory/extract.ts").TextOnlyExtractor;
  const result = await captureBotReveals(completed!, () => roster, extractor, new AbortController().signal);
  expect(result).toMatchObject({ written: true });
  const records = readBotIdentity(owner, "capture-reveal-bot", roster).records.filter(row => row.kind === "reveal-state");
  expect(records).toHaveLength(1); noSecrets(records);
  expect(JSON.parse(String(records[0].text))).toMatchObject({ audience: "owner-private", revealed: true });
});

it("serialized.memory-bring-in.excerpt-retains-original-secret-context", async () => {
  const { bringInToProject } = await import("./memory/bring-in.ts");
  const { appendMessage } = await import("./message-db.ts");
  const roster = { bots: [{ id: "excerpt-bot", threadId: "excerpt-thread" }], groups: [{ id: "excerpt-room", threadId: "excerpt-room-thread", memberIds: ["excerpt-bot"] }] };
  reconcileMemoryRoster(roster);
  appendMessage("excerpt-thread", { id: "excerpt-message", at: 1, role: "user", kind: "text", origin: "desktop", text: markdown });
  const db = database();
  const result = bringInToProject(db, { groupId: "excerpt-room", roomThreadId: "excerpt-room-thread", botId: "excerpt-bot", roster, now: Date.now(), sourceMessageId: "excerpt-message", threadId: "excerpt-thread", text: "TAILSECRET" });
  expect(result.ok).toBe(true);
  if (result.ok) noSecrets(db.prepare("SELECT text FROM memory_records WHERE id=?").get(result.recordId));
  expect(db.prepare("SELECT text FROM messages WHERE id='excerpt-message'").get()?.text).toBe(markdown);
});
it("serialized.memory-feedback.original-before-normalization", async () => {
  const { decideFeedback } = await import("./memory/feedback.ts"), redaction = await import("./redact.ts");
  const spy = vi.spyOn(redaction, "redactSecretsInText"), text = `No, use ${markdown} instead.`;
  try {
    const result = await decideFeedback({ text, turn: null, replied: true, now: 1, at: 1, classifier: null });
    expect(result.kind).toBe("feedback");
    expect(spy).toHaveBeenCalledWith(text); noSecrets(result);
  } finally { spy.mockRestore(); }
});
