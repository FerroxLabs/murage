// SPDX-License-Identifier: AGPL-3.0-or-later
// Actual poisoned-output fixtures shared with the historical boundary suite.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { Store } from "../store.ts";
import { initializeArtifacts, registerArtifact, describeArtifact } from "../artifacts.ts";
import { insertMemoryRecord } from "../memory/record-write.ts";
import { database } from "../database.ts";
import { reconcileMemoryRoster, ensureScope } from "../memory/policy.ts";
import { captureSource } from "../memory/capture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
const markdown = "**password**: hunter2\nTAILSECRET";
const existing = ("api_key=OLDSECR" + "ET123456");
const noSecrets = (output: unknown) => expect(JSON.stringify(output)).not.toMatch(/hunter2|TAILSECRET|OLDSECRET123456|SIBLINGSECRET/);
export const historicalSinkWitnesses: Record<string, () => unknown> = {
    "server/store.ts": () => {
        const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
        const bot = store.createBot();
        const input = { role: "bot" as const, kind: "activity" as const, text: "SIBLINGSECRET", tool: { name: "read", summary: existing, spoken: "SIBLINGSECRET" } };
        const before = JSON.stringify(input);
        const row = store.appendMessage(bot.threadId, input);
        noSecrets(row);
        expect(JSON.stringify(input)).toBe(before);
    },
    "server/artifacts.ts": () => {
        const root = mkdtempSync(join(tmpdir(), "l5a-artifact-"));
        const db = new DatabaseSync(":memory:");
        try {
            const workspace = join(root, "workspace"), storage = join(root, "saved");
            mkdirSync(workspace);
            mkdirSync(join(workspace, existing));
            writeFileSync(join(workspace, existing, "report.txt"), markdown);
            initializeArtifacts(db);
            const access = { owner: true, scopes: [{ botId: "bot", botName: "SIBLINGSECRET", threadId: "thread", workspaceRoot: workspace }] };
            const saved = registerArtifact(db, storage, { botId: "bot", threadId: "thread", relativePath: `${existing}/report.txt`, name: existing }, access);
            // Simulate an older stored title, bypassing today's registration scrub.
            db.prepare("UPDATE artifacts SET name=? WHERE id=?").run(existing, saved.id);
            noSecrets(describeArtifact(db, storage, saved.id, access));
            expect(readFileSync(join(workspace, existing, "report.txt"), "utf8")).toBe(markdown);
        }
        finally {
            db.close();
            removeTempDirSync(root);
        }
    },
    "server/inbox.ts": async () => {
        const { initializeInbox, listInbox } = await import("../inbox.ts");
        const db = new DatabaseSync(":memory:");
        try {
            db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id))");
            initializeInbox(db);
            const row = { id: "card", at: 100, role: "bot", kind: "options", card: { requestId: "request", title: existing, subtitle: "SIBLINGSECRET", tool: "Bash", options: ["Allow", "Deny"] } };
            db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("thread", "card", 100, "bot", "options", null, JSON.stringify(row));
            const before = db.prepare("SELECT json FROM messages").get();
            const page = listInbox(db, {}, { owner: true, threads: [{ threadId: "thread", label: "Bot", botId: "bot" }] });
            expect(page.items).toHaveLength(1);
            noSecrets(page);
            expect(page.items[0].link).toMatchObject({ threadId: "thread", messageId: "card" });
            expect(db.prepare("SELECT json FROM messages").get()).toEqual(before);
        }
        finally {
            db.close();
        }
    },
    "server/memory/authority.ts": async () => {
        const { ownerMemoryTicket, rememberMemory } = await import("../memory/authority.ts");
        const input = { actionId: "l5a-remember", text: `Project uses ${existing}` };
        expect(() => rememberMemory({}, input)).toThrow("MEMORY_OWNER_REQUIRED");
        const saved = rememberMemory(ownerMemoryTicket(), input);
        noSecrets(database().prepare("SELECT text FROM memory_records WHERE id=?").get(saved.id));
        expect(input.text).toContain(("OLDSECR" + "ET123456"));
    },
    "server/memory/import.ts": async () => {
        const { ownerMemoryTicket } = await import("../memory/authority.ts");
        const { previewMemoryImport, commitMemoryImport } = await import("../memory/import.ts");
        const { DATA_DIR } = await import("../config.ts");
        const roster = { bots: [{ id: "import-bot", threadId: "import-thread", section: "Secret boundary" }], groups: [] };
        reconcileMemoryRoster(roster);
        const file = join(DATA_DIR, "section-contexts.json"), original = JSON.stringify({ version: 1, contexts: { "Secret boundary": { text: existing } } });
        writeFileSync(file, original);
        const owner = ownerMemoryTicket(), preview = previewMemoryImport(owner, [{ kind: "section", section: "Secret boundary" }], roster);
        expect(preview.items).toHaveLength(1);
        noSecrets(preview);
        noSecrets(commitMemoryImport(owner, preview.previewId, roster));
        expect(readFileSync(file, "utf8")).toBe(original);
    },
    "server/memory/identity.ts": async () => {
        const { ownerMemoryTicket } = await import("../memory/authority.ts");
        const { writeBotIdentity, readBotIdentity } = await import("../memory/identity.ts");
        const roster = { bots: [{ id: "reveal-bot", threadId: "reveal-thread" }], groups: [] };
        reconcileMemoryRoster(roster);
        const owner = ownerMemoryTicket();
        const canon = writeBotIdentity(owner, { action: "identity-write", botId: "reveal-bot", kind: "character-canon", key: "canon", expectedVersion: 0, text: "Fictional lighthouse", basis: "fiction", audience: "owner-private" }, roster);
        const input = { action: "identity-write" as const, botId: "reveal-bot", kind: "reveal-state" as const, key: "state", expectedVersion: 0, text: markdown, basis: "fiction" as const, audience: "owner-private" as const, canon: { id: canon.id, version: canon.version }, revealed: false };
        const saved = writeBotIdentity(owner, input, roster);
        const row = readBotIdentity(owner, "reveal-bot", roster).records.find(row => row.id === saved.id)!;
        expect(JSON.parse(String(row.text))).toMatchObject({ canonId: canon.id, audience: "owner-private", revealed: false });
        noSecrets(row);
        expect(input.text).toBe(markdown);
    },
    "server/memory/pip-reflect.ts": async () => {
        const { supportCopy } = await import("../memory/pip-reflect.ts");
        const line = supportCopy({ status: "unsupported", reason: `inspection-failed ${existing}`, at: 1 }, "SIBLINGSECRET");
        expect(line).toContain("Reflection needs");
        noSecrets(line);
    },
    "server/memory/feedback.ts": async () => {
        const { decideFeedback } = await import("../memory/feedback.ts"), redaction = await import("../redact.ts");
        const spy = vi.spyOn(redaction, "redactSecretsInText"), text = `No, use ${markdown} instead.`;
        try {
            const result = await decideFeedback({ text, turn: null, replied: true, now: 1, at: 1, classifier: null });
            expect(result.kind).toBe("feedback");
            expect(spy).toHaveBeenCalledWith(text);
            noSecrets(result);
        }
        finally {
            spy.mockRestore();
        }
    },
    "server/memory/outcomes.ts": async () => {
        const { MEMORY_SCHEMA } = await import("../memory/schema.ts");
        const { markOutcome, captureApprovalDecision } = await import("../memory/outcomes.ts");
        const db = new DatabaseSync(":memory:");
        try {
            db.exec(MEMORY_SCHEMA);
            db.exec("INSERT INTO memory_meta(id,schema_version,installation_id,mode) VALUES(1,13,'test','active')");
            db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id))");
            db.prepare("INSERT INTO messages VALUES('thread','message',1,'bot','text','answer',?)").run(JSON.stringify({ id: "message", role: "bot", kind: "text", text: "answer", at: 1 }));
            noSecrets(markOutcome(db, { botId: "bot", threadId: "thread", messageId: "message", kind: "won", reason: existing, now: 2 }));
            captureApprovalDecision(db, { botId: "bot", threadId: "thread", requestId: "request", tool: existing, approved: false, now: 3 }, { id: "bot", learning: { enabled: true, askFirst: false, prospectLearning: false, revision: 0 } });
            noSecrets(db.prepare("SELECT target_action,correction FROM memory_feedback").all());
        }
        finally {
            db.close();
        }
    },
    "server/memory/review.ts": async () => {
        const { ownerMemoryTicket } = await import("../memory/authority.ts");
        const { reviewSources } = await import("../memory/review.ts");
        const roster = { bots: [{ id: "review-bot", threadId: "review-thread", name: "Review" }], groups: [] };
        reconcileMemoryRoster(roster);
        const db = database(), text = `${existing}\n${"ordinary ".repeat(80)}`;
        captureSource(db, { id: "review-source", threadId: "review-thread", kind: "message", speaker: "owner", outcome: "observed", text: "old placeholder" });
        db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='review-source'").run(JSON.stringify({ text }));
        insertMemoryRecord(db, { id: "review-record", version: 1, scopeId: ensureScope("bot", "review-bot"), kind: "fact", text: "Candidate", assertion: "assistant-inference", state: "candidate", validFrom: 1, createdAt: 1 });
        db.prepare("INSERT INTO memory_evidence VALUES('review-record',1,'review-source',1,0,?)").run(Buffer.byteLength(text));
        const before = db.prepare("SELECT payload FROM memory_source_versions WHERE source_id='review-source'").get();
        const output = reviewSources(ownerMemoryTicket(), roster, { id: "review-record", version: 1 });
        expect(output.sources).toHaveLength(1);
        noSecrets(output);
        expect(output.sources[0].excerpt.length).toBeLessThanOrEqual(400);
        expect(db.prepare("SELECT payload FROM memory_source_versions WHERE source_id='review-source'").get()).toEqual(before);
    },
    "server/memory/settings.ts": async () => {
        const { ownerMemoryTicket } = await import("../memory/authority.ts");
        const { memoryOwnerRoute } = await import("../memory/settings.ts");
        const roster = { bots: [{ id: "inspect-bot", threadId: "inspect-thread" }], groups: [] };
        reconcileMemoryRoster(roster);
        const db = database();
        captureSource(db, { id: "inspect-source", threadId: "inspect-thread", kind: "message", speaker: "owner", outcome: "observed", text: "old placeholder" });
        // A historical evidence payload predates the write-time credential mask.
        const payload = JSON.stringify({ text: markdown });
        db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='inspect-source'").run(payload);
        insertMemoryRecord(db, { id: "inspect-record", version: 1, scopeId: ensureScope("bot", "inspect-bot"), kind: "fact", text: "Candidate", assertion: "assistant-inference", state: "candidate", validFrom: 1, createdAt: 1 });
        db.prepare("INSERT INTO memory_evidence VALUES('inspect-record',1,'inspect-source',1,0,?)").run(Buffer.byteLength(markdown));
        const output = await memoryOwnerRoute("/api/memory/action", { action: "inspect", id: "inspect-record", version: 1 }, ownerMemoryTicket(), roster) as {
            evidence: Array<{
                text: string;
            }>;
        };
        expect(output.evidence).toHaveLength(1);
        expect(output.evidence[0].text).toContain("redacted");
        noSecrets(output);
        expect(db.prepare("SELECT payload FROM memory_source_versions WHERE source_id='inspect-source'").get()?.payload).toBe(payload);
    },
    "server/memory/capture.ts": () => {
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
    },
    "server/memory/consolidate.ts": async () => {
        const { appendMessage } = await import("../message-db.ts");
        const { claimMemoryJob, publishMemoryWork } = await import("../memory/jobs.ts");
        const { captureWork } = await import("../memory/chunks.ts");
        const { refreshMemoryCheckpoint } = await import("../memory/consolidate.ts");
        const roster = { bots: [{ id: "consolidate-bot", threadId: "consolidate-thread" }], groups: [] };
        reconcileMemoryRoster(roster);
        appendMessage("consolidate-thread", { id: "consolidate-message", at: 1, role: "user", kind: "text", origin: "desktop", text: existing });
        let work, completed: string | undefined;
        while ((work = claimMemoryJob("l5a-fixture"))) {
            publishMemoryWork(work, "l5a-fixture", captureWork(work));
            if (work.sourceId === "message:consolidate-thread:consolidate-message")
                completed = work.id;
        }
        expect(completed).toBeTruthy();
        const output = refreshMemoryCheckpoint(completed!);
        expect(output.status).not.toBe("deferred");
        const rows = database().prepare("SELECT text FROM memory_records WHERE kind='checkpoint' AND scope_id=?").all(ensureScope("conversation", "consolidate-thread"));
        expect(rows.length).toBeGreaterThan(0);
        noSecrets(rows);
    },
    "server/memory/bring-in.ts": async () => {
        const { bringInToProject, BRING_IN_MAX_CHARS } = await import("../memory/bring-in.ts");
        const redaction = await import("../redact.ts");
        const { appendMessage } = await import("../message-db.ts");
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
                expect(String(row.text).length).toBeLessThanOrEqual(BRING_IN_MAX_CHARS);
                noSecrets(row);
            }
            expect(db.prepare("SELECT text FROM messages WHERE id='bring-message'").get()).toEqual(before);
        }
        finally {
            spy.mockRestore();
        }
    },
    "server/memory/reveal-capture.ts": async () => {
        const { ownerMemoryTicket } = await import("../memory/authority.ts");
        const { writeBotIdentity, readBotIdentity } = await import("../memory/identity.ts");
        const { appendMessage } = await import("../message-db.ts");
        const { claimMemoryJob, publishMemoryWork } = await import("../memory/jobs.ts");
        const { captureWork } = await import("../memory/chunks.ts");
        const { captureBotReveals } = await import("../memory/reveal-capture.ts");
        const roster = { bots: [{ id: "capture-reveal-bot", threadId: "capture-reveal-thread" }], groups: [] };
        reconcileMemoryRoster(roster);
        const owner = ownerMemoryTicket(), text = "Fiction: I tended the lighthouse.";
        writeBotIdentity(owner, { action: "identity-write", botId: "capture-reveal-bot", kind: "character-canon", key: "canon", expectedVersion: 0, text, basis: "fiction", audience: "owner-private" }, roster);
        appendMessage("capture-reveal-thread", { id: "capture-reveal-message", at: 1, role: "bot", kind: "text", text: `${text}\n${markdown}`, turnId: "host-turn", turnTerminal: true });
        let work, completed: string | undefined;
        while ((work = claimMemoryJob("l5a-fixture"))) {
            publishMemoryWork(work, "l5a-fixture", captureWork(work));
            if (work.sourceId === "message:capture-reveal-thread:capture-reveal-message")
                completed = work.id;
        }
        expect(completed).toBeTruthy();
        const extractor = Object.assign(async () => "[]", { ground: async () => JSON.stringify({ supported: true }) }) as import("../memory/extract.ts").TextOnlyExtractor;
        const result = await captureBotReveals(completed!, () => roster, extractor, new AbortController().signal);
        expect(result).toMatchObject({ written: true });
        const records = readBotIdentity(owner, "capture-reveal-bot", roster).records.filter(row => row.kind === "reveal-state");
        expect(records).toHaveLength(1);
        noSecrets(records);
        expect(JSON.parse(String(records[0].text))).toMatchObject({ audience: "owner-private", revealed: true });
    },
    "server/routines.ts": async () => {
        const { RoutineManager } = await import("../routines.ts");
        const dir = mkdtempSync(join(tmpdir(), "l5a-routine-"));
        const sent: string[] = [], emitted: unknown[] = [];
        const manager = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "routine-thread" }), startTurn: async (_bot, _thread, text) => {
                sent.push(text);
            }, interruptTurn: async () => {
            }, emit: frame => {
                if (frame.kind === "routine.run")
                    emitted.push(frame);
            } });
        try {
            const prompt = "Read the original file.\nKeep its bytes: α β.";
            const routine = manager.create({ name: "Fixture", prompt, botId: "bot", target: "bot", runOn: "ember", enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() } });
            manager.runNow(routine.id);
            await expect.poll(() => sent.length).toBe(1);
            expect(sent[0]).toBe(prompt);
            manager.handleRuntimeEvent({ type: "turn.started", threadId: "routine-thread", turnId: "routine-turn" } as never);
            manager.handleRuntimeEvent({ type: "item.completed", threadId: "routine-thread", turnId: "routine-turn", itemType: "assistant_text", text: existing } as never);
            manager.handleRuntimeEvent({ type: "runtime.error", threadId: "routine-thread", turnId: "routine-turn", message: existing } as never);
            expect(emitted.length).toBeGreaterThan(0);
            noSecrets(emitted);
            expect(manager.listRuns()[0].output).toContain("redacted");
            expect(manager.listRuns()[0].error).toContain("redacted");
            const persisted = readFileSync(join(dir, "routines.json"), "utf8");
            noSecrets(persisted);
        }
        finally {
            manager.stop();
            removeTempDirSync(dir);
        }
    },
    "server/drivers/pi.ts": async () => {
        const { piToolErrorDetail } = await import("../drivers/pi.ts");
        const input = { result: markdown };
        noSecrets(piToolErrorDetail(input));
        expect(input.result).toBe(markdown);
    },
};
