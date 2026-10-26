import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { checkHeldRelease, fenceRestoredSql, releaseHeldItem, releaseRestoreHold, sqlRowRestoreHeld } from "./restore-fence.ts";
import { ARTIFACT_PREVIEW_MAX_BYTES, ARTIFACT_TEXT_EXTENSIONS, describeArtifact, listArtifacts, previewArtifact, registerArtifact, type ArtifactScope } from "./artifacts.ts";
import { ensureTaskWorkspace } from "./workspace.ts";
import {
  completeImageOutput, createOutputPublisher, managedImageOutputPath, outputReceiptsForRun, publishAssistantImage, resumePendingAssistantImages, retainImageOutput,
} from "./output-publication.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { __setFreeDiskProbeForTests } from "./disk-space.ts";
import { __setAttachmentReadHookForTests } from "./attachment-read.ts";

const faults = vi.hoisted(() => ({ saveImage: 0, register: 0 }));
// Files quota fault: the next N saves to Files (registerArtifact) are refused with the quota status.
vi.mock("./artifacts.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./artifacts.ts")>();
  return { ...actual, registerArtifact: (...args: Parameters<typeof actual.registerArtifact>) => {
    if (faults.register > 0) { faults.register--; throw Object.assign(new Error("Files quota reached"), { status: 507 }); }
    return actual.registerArtifact(...args);
  } };
});
vi.mock("./attachments.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./attachments.ts")>();
  return { ...actual, saveImage: (...args: Parameters<typeof actual.saveImage>) => {
    if (faults.saveImage > 0) { faults.saveImage--; throw Object.assign(new Error("attachments storage is full"), { status: 507 }); }
    return actual.saveImage(...args);
  }, saveReceiptImage: (...args: Parameters<typeof actual.saveReceiptImage>) => {
    if (faults.saveImage > 0) { faults.saveImage--; throw Object.assign(new Error("attachments storage is full"), { status: 507 }); }
    return actual.saveReceiptImage(...args);
  }, writeNewReceiptImage: (...args: Parameters<typeof actual.writeNewReceiptImage>) => {
    if (faults.saveImage > 0) { faults.saveImage--; throw Object.assign(new Error("attachments storage is full"), { status: 507 }); }
    return actual.writeNewReceiptImage(...args);
  } };
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const storage = () => join(DATA_DIR, "artifact-files");

beforeEach(() => { faults.saveImage = 0; faults.register = 0; closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })); const bot = store.createBot();
  const workspace = ensureTaskWorkspace(bot.id, bot.threadId);
  const taskScope: ArtifactScope = { botId: bot.id, botName: bot.name, threadId: bot.threadId, workspaceRoot: workspace };
  const imageScope: ArtifactScope = { botId: bot.id, botName: bot.name, threadId: bot.threadId, workspaceRoot: managedImageOutputPath(DATA_DIR, bot.id, bot.threadId), managedOutput: true };
  const scopes = () => [taskScope, imageScope];
  const publisher = createOutputPublisher({ dataDir: DATA_DIR, database, store, artifactScopes: scopes });
  const runId = randomUUID();
  const dispatch = (managed = true, run = runId) => publisher.beforeDispatch({ botId: bot.id, threadId: bot.threadId, runId: run, workspaceRoot: realpathSync(workspace), managed });
  const complete = (ok = true, stopReason?: string) => publisher.publishTerminalOutputs({ type: "turn.completed", turnId: "provider-turn", ok, ...(stopReason ? { stopReason } : {}), threadId: bot.threadId, eventId: randomUUID() } as never);
  const write = (relativePath: string, content: string | Buffer) => { const path = join(workspace, ...relativePath.split("/")); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path; };
  const cards = () => store.messagesFor(bot.threadId).filter(message => message.artifactIds?.length);
  const hostMessages = () => store.messagesFor(bot.threadId).filter(message => message.role === "bot" && message.kind === "text" && /Saved|could not be saved/.test(message.text ?? ""));
  const receipts = (run = runId) => outputReceiptsForRun(database(), "shell-output", bot.id, bot.threadId, run);
  const access = { owner: true, scopes: scopes() };
  return { store, bot, workspace, taskScope, imageScope, publisher, runId, dispatch, complete, write, cards, hostMessages, receipts, access };
}

it("publishes a shell-written outputs/ report from a successful managed turn as one verified saved file and one persisted card", async () => {
  const f = fixture();
  f.dispatch();
  expect(existsSync(join(f.workspace, "outputs"))).toBe(true);
  const content = "<!doctype html><h1>Weekly report</h1><p>Three verified updates.</p>";
  f.write("outputs/weekly/report.html", content);
  f.write("notes/elsewhere.md", "outside the publication namespace");
  await f.complete(true);

  const cards = f.cards();
  expect(cards).toHaveLength(1);
  expect(cards[0]!.text).toBe("Saved file: report.html");
  const [id] = cards[0]!.artifactIds!;
  expect(describeArtifact(database(), storage(), id!, f.access)).toMatchObject({
    sha256: sha(content), producer: "shell-output", runId: f.runId, relativePath: "outputs/weekly/report.html", threadId: f.bot.threadId, sourceState: "current", sourceConversationAvailable: true,
  });
  expect(f.receipts()).toEqual([expect.objectContaining({ stage: "registered", artifactId: id, messageId: cards[0]!.id, pathToken: "outputs/weekly/report.html", sha256: sha(content), mime: "text/html" })]);
  expect(listArtifacts(database(), storage(), {}, f.access).items.map(item => item.relativePath)).toEqual(["outputs/weekly/report.html"]);

  // A repeated terminal event without a new dispatch publishes nothing more.
  await f.complete(true);
  expect(f.cards()).toHaveLength(1);

  // The saved revision is retained when the original changes, and the card
  // survives reopening the conversation from durable storage.
  f.write("outputs/weekly/report.html", "changed after publication");
  expect(previewArtifact(database(), storage(), id!, f.access)).toMatchObject({ content, artifact: { id, sourceState: "changed" } });
  const reopened = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  expect(reopened.messagesFor(f.bot.threadId).filter(message => message.artifactIds?.includes(id!)).map(message => message.id)).toEqual([cards[0]!.id]);
});

// RED2E: the receipt mime follows the shared artifact text list
// (ARTIFACT_TEXT_EXTENSIONS) under the artifact preview's bounds, not a
// narrower private list: a .py output is text and previews inline; a binary,
// a non-UTF-8 blob behind a text extension and an oversized text file are
// octet streams that download.
it("records source outputs as text under the shared artifact list and binaries as octet streams", async () => {
  const f = fixture();
  f.dispatch();
  const script = "def main():\n    print('verified')\n";
  f.write("outputs/tools/report.py", script);
  f.write("outputs/tools/model.bin", png);
  f.write("outputs/tools/blob.py", Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
  f.write("outputs/tools/big.py", Buffer.concat([Buffer.from("# "), Buffer.alloc(ARTIFACT_PREVIEW_MAX_BYTES, 0x61)]));
  await f.complete(true);

  const byPath = Object.fromEntries(f.receipts().map(receipt => [receipt.pathToken, receipt]));
  expect(byPath["outputs/tools/report.py"]).toMatchObject({ stage: "registered", mime: "text/plain", bytes: Buffer.byteLength(script) });
  expect(byPath["outputs/tools/model.bin"]).toMatchObject({ stage: "registered", mime: "application/octet-stream" });
  expect(byPath["outputs/tools/blob.py"]).toMatchObject({ stage: "registered", mime: "application/octet-stream" });
  expect(byPath["outputs/tools/big.py"]).toMatchObject({ stage: "registered", mime: "application/octet-stream", bytes: ARTIFACT_PREVIEW_MAX_BYTES + 2 });
  expect(ARTIFACT_TEXT_EXTENSIONS).toContain(".py");

  // The saved copies agree with the receipts: the script previews inline as
  // text; the others are download-only.
  const preview = (path: string) => previewArtifact(database(), storage(), byPath[path]!.artifactId!, f.access);
  expect(preview("outputs/tools/report.py")).toMatchObject({ mode: "text", content: script, artifact: { kind: "text", mime: "text/plain" } });
  expect(preview("outputs/tools/model.bin")).toMatchObject({ mode: "download", artifact: { kind: "other" } });
  expect(preview("outputs/tools/blob.py")).toMatchObject({ mode: "download" });
  expect(preview("outputs/tools/big.py")).toMatchObject({ mode: "download" });
  expect(f.cards()).toHaveLength(1);
  expect(f.cards()[0]!.text).toBe("Saved 4 files: big.py, blob.py, model.bin, report.py");
});

it("publishes only files that are new or changed since dispatch", async () => {
  const f = fixture();
  f.write("outputs/old.txt", "unchanged");
  f.write("outputs/edited.txt", "v1");
  f.dispatch();
  f.write("outputs/edited.txt", "version two");
  f.write("outputs/new.csv", "a,b\n1,2\n");
  await f.complete();
  expect(f.cards().map(message => message.text)).toEqual(["Saved 2 files: edited.txt, new.csv"]);
  expect(listArtifacts(database(), storage(), {}, f.access).items.map(item => item.relativePath).sort()).toEqual(["outputs/edited.txt", "outputs/new.csv"]);
});

it("reuses the saved version when a later run rewrites identical bytes, and saves changed bytes as a new version", async () => {
  const f = fixture(), second = randomUUID(), third = randomUUID();
  f.dispatch();
  f.write("outputs/report.html", "<p>same bytes</p>");
  await f.complete();
  const [card] = f.cards();
  const savedId = card!.artifactIds![0]!;

  f.dispatch(true, second);
  const path = f.write("outputs/report.html", "<p>same bytes</p>");
  utimesSync(path, new Date(), new Date(Date.now() + 60_000)); // a real rewrite, visible to the snapshot diff
  await f.complete();
  expect(f.cards().map(message => message.id)).toEqual([card!.id]);
  expect(f.receipts(second)).toEqual([expect.objectContaining({ stage: "registered", artifactId: savedId })]);
  expect(listArtifacts(database(), storage(), {}, f.access).total).toBe(1);

  f.dispatch(true, third);
  f.write("outputs/report.html", "<p>new bytes</p>");
  await f.complete();
  const cards = f.cards();
  expect(cards).toHaveLength(2);
  expect(cards[1]!.artifactIds).not.toContain(savedId);
  expect(listArtifacts(database(), storage(), {}, f.access).total).toBe(2);
  expect(previewArtifact(database(), storage(), savedId, f.access).content).toBe("<p>same bytes</p>");
});

it("keeps verified receipts for a failed or cancelled turn but registers and announces nothing", async () => {
  const f = fixture();
  f.dispatch();
  f.write("outputs/draft.html", "<p>draft</p>");
  await f.complete(false);
  expect(f.hostMessages()).toEqual([]);
  expect(listArtifacts(database(), storage(), {}, f.access).total).toBe(0);
  const receipts = f.receipts();
  expect(receipts).toEqual([expect.objectContaining({ stage: "retained", sha256: sha("<p>draft</p>"), bytes: 12, pathToken: "outputs/draft.html" })]);
  expect(receipts[0]!.artifactId).toBeUndefined();
  expect(receipts[0]!.messageId).toBeUndefined();
});

it("treats a stopped turn (ok:true, stopReason cancelled) like a cancelled one: receipts retained, nothing registered or announced (STOP1, U-02)", async () => {
  const f = fixture();
  f.dispatch();
  f.write("outputs/partial.html", "<p>half-written</p>");
  // Every engine settles a user Stop as ok:true "cancelled", not ok:false.
  await f.complete(true, "cancelled");
  expect(f.hostMessages()).toEqual([]);
  expect(f.cards()).toEqual([]);
  expect(listArtifacts(database(), storage(), {}, f.access).total).toBe(0);
  const receipts = f.receipts();
  expect(receipts).toEqual([expect.objectContaining({ stage: "retained", sha256: sha("<p>half-written</p>"), pathToken: "outputs/partial.html" })]);
  expect(receipts[0]!.artifactId).toBeUndefined();
  expect(receipts[0]!.messageId).toBeUndefined();
});

it("treats Murage's own Ask stop (ok:true, stopReason ask_stop) as a stop: receipts retained, nothing registered or announced", async () => {
  const f = fixture();
  f.dispatch();
  f.write("outputs/partial.html", "<p>half-written</p>");
  await f.complete(true, "ask_stop");
  expect(f.hostMessages()).toEqual([]);
  expect(f.cards()).toEqual([]);
  expect(listArtifacts(database(), storage(), {}, f.access).total).toBe(0);
  const receipts = f.receipts();
  expect(receipts).toEqual([expect.objectContaining({ stage: "retained", sha256: sha("<p>half-written</p>"), pathToken: "outputs/partial.html" })]);
  expect(receipts[0]!.artifactId).toBeUndefined();
});

it("never snapshots or publishes an unmanaged workspace", async () => {
  const f = fixture();
  f.dispatch(false);
  expect(existsSync(join(f.workspace, "outputs"))).toBe(false);
  f.write("outputs/report.html", "<p>custom folder</p>");
  await f.complete();
  // A managed dispatch replaced by an unmanaged one drops the earlier snapshot.
  f.dispatch(true);
  f.dispatch(false);
  f.write("outputs/second.html", "<p>second</p>");
  await f.complete();
  expect(f.hostMessages()).toEqual([]);
  expect(f.receipts()).toEqual([]);
  expect(listArtifacts(database(), storage(), {}, f.access).total).toBe(0);
});

it("bounds automatic publication to 20 ordinary files of at most 25 MiB and skips links, hidden and private names", async () => {
  const f = fixture();
  f.dispatch();
  for (let index = 0; index < 21; index++) f.write(`outputs/batch/file-${String(index).padStart(2, "0")}.txt`, `file ${index}`);
  const big = join(f.workspace, "outputs", "big.bin"), fd = openSync(big, "w");
  try { ftruncateSync(fd, 25 * 1024 * 1024 + 1); } finally { closeSync(fd); }
  f.write("outputs/.hidden.txt", "hidden");
  f.write("outputs/memory/notes.md", "private notes");
  linkSync(f.write("outputs/hard-a.txt", "hard"), join(f.workspace, "outputs", "hard-b.txt"));
  let links = 2;
  if (process.platform !== "win32") { symlinkSync(f.write("secret.txt", "outside"), join(f.workspace, "outputs", "link.txt")); links++; }
  await f.complete();

  const cards = f.cards();
  expect(cards).toHaveLength(1);
  expect(cards[0]!.artifactIds).toHaveLength(20);
  const notSaved = 1 /* big */ + 1 /* memory */ + links + 1 /* 21st file */;
  expect(cards[0]!.text).toContain("Saved 20 files: file-00.txt");
  expect(cards[0]!.text).toContain(`${notSaved} files in outputs/ could not be saved automatically`);
  const receipts = f.receipts();
  expect(receipts).toHaveLength(20);
  expect(receipts.every(receipt => receipt.stage === "registered" && receipt.pathToken.startsWith("outputs/batch/"))).toBe(true);
  expect(receipts.map(receipt => receipt.pathToken)).not.toContain("outputs/batch/file-20.txt");
});

it("does not add a second card for an output the bot already registered in the same run", async () => {
  const f = fixture();
  f.dispatch();
  f.write("outputs/report.html", "<p>registered by tool</p>");
  const tool = registerArtifact(database(), storage(), { botId: f.bot.id, threadId: f.bot.threadId, relativePath: "outputs/report.html" }, { owner: true, scopes: [{ ...f.taskScope, runId: f.runId }] });
  f.store.appendMessage(f.bot.threadId, { role: "bot", kind: "text", text: `Saved file: ${tool.name}`, artifactIds: [tool.id] });
  await f.complete();
  expect(f.cards().map(message => message.artifactIds)).toEqual([[tool.id]]);
  expect(f.receipts()).toEqual([expect.objectContaining({ stage: "registered", artifactId: tool.id })]);
  expect(listArtifacts(database(), storage(), {}, f.access).total).toBe(1);
});

it("keeps a failed receipt and says so when Files cannot save an output", async () => {
  const f = fixture();
  writeFileSync(storage(), "not a directory");
  f.dispatch();
  const report = f.write("outputs/report.html", "<p>kept</p>");
  await f.complete();
  expect(f.cards()).toEqual([]);
  expect(f.hostMessages().map(message => message.text)).toEqual(["1 file in outputs/ could not be saved automatically and remain in the task workspace."]);
  const [receipt] = f.receipts();
  expect(receipt).toMatchObject({ stage: "failed", errorCategory: "verification", sha256: sha("<p>kept</p>") });
  expect(receipt!.artifactId).toBeUndefined();
  expect(readFileSync(report, "utf8")).toBe("<p>kept</p>");
});

async function recoverShell(f: ReturnType<typeof fixture>) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const publisher = createOutputPublisher({ dataDir: DATA_DIR, database, store, artifactScopes: () => [f.taskScope, f.imageScope] });
  await publisher.resumePending();
  await publisher.resumePending();
  return store.messagesFor(f.bot.threadId).filter(message => message.artifactIds?.length);
}

it("recovers registered shell cards after transcript failure with the same HTML, MD and TXT saved identities", async () => {
  const f = fixture(); f.dispatch();
  for (const extension of ["html", "md", "txt"]) f.write(`outputs/report.${extension}`, `verified ${extension}`);
  const append = vi.spyOn(f.store, "appendMessage").mockImplementationOnce(() => { throw new Error("transcript unavailable"); });
  await f.complete(); append.mockRestore();
  expect(f.cards()).toEqual([]);
  const receipts = f.receipts();
  expect(receipts).toHaveLength(3);
  expect(receipts.every(receipt => receipt.stage === "registered" && receipt.errorCategory === "transcript")).toBe(true);
  const cards = (await recoverShell(f));
  expect(cards).toHaveLength(1);
  expect(cards[0]!.artifactIds!.slice().sort()).toEqual(receipts.map(receipt => receipt.artifactId!).sort());
  for (const receipt of f.receipts()) {
    expect(receipt.messageId).toBe(cards[0]!.id);
    expect(previewArtifact(database(), storage(), receipt.artifactId!, f.access).content).toBe(`verified ${receipt.pathToken.split(".").at(-1)}`);
  }
  expect(listArtifacts(database(), storage(), {}, f.access).total).toBe(3);
});

it("a recovered shell card names the turn recorded with its receipt, after a restart that lost the capability's turn state", async () => {
  const f = fixture(); f.dispatch(); f.write("outputs/report.txt", "verified");
  const append = vi.spyOn(f.store, "appendMessage").mockImplementationOnce(() => { throw new Error("transcript unavailable"); });
  await f.complete(); append.mockRestore();
  expect(f.receipts()[0]).toMatchObject({ turnId: "provider-turn" });
  const [card] = await recoverShell(f);
  expect(card!.turnId).toBe("provider-turn");
});

it("a recovered shell card with no recorded turn is withheld, never shown unattributed; the file stays in Files", async () => {
  const f = fixture(); f.dispatch(); f.write("outputs/report.txt", "verified");
  const append = vi.spyOn(f.store, "appendMessage").mockImplementationOnce(() => { throw new Error("transcript unavailable"); });
  // the terminal event names no turn and the capability knows none
  await f.publisher.publishTerminalOutputs({ type: "turn.completed", ok: true, threadId: f.bot.threadId, eventId: randomUUID() } as never); append.mockRestore();
  expect(f.receipts()[0]).toMatchObject({ stage: "registered" });
  expect(f.receipts()[0]!.turnId).toBeUndefined();
  expect(await recoverShell(f)).toEqual([]);
  expect(f.receipts()[0]!.messageId).toBeUndefined();
  expect(listArtifacts(database(), storage(), {}, f.access).total).toBe(1);
});

it("reconciles a shell card committed before its acknowledgement was lost without adding another card", async () => {
  const f = fixture(); f.dispatch(); f.write("outputs/report.txt", "verified");
  const original = f.store.appendMessage.bind(f.store);
  const append = vi.spyOn(f.store, "appendMessage").mockImplementationOnce((...args) => { original(...args); throw new Error("lost acknowledgement"); });
  await f.complete(); append.mockRestore();
  const [card] = f.cards();
  expect(f.receipts()[0]!.messageId).toBeUndefined();
  expect((await recoverShell(f)).map(message => message.id)).toEqual([card!.id]);
  expect(f.receipts()[0]!.messageId).toBe(card!.id);
});
it.each([false,true])("registered room output recovery respects current membership (removed=%s)",async removed=>{
  const f=fixture(),other=f.store.createBot(),room=f.store.createGroup("Output room",[f.bot.id,other.id]);
  f.store.admitLocalOutputs(f.bot.id,room.threadId);
  const root=ensureTaskWorkspace(f.bot.id,room.threadId),scope={...f.taskScope,threadId:room.threadId,workspaceRoot:root},runId=randomUUID();
  const publisher=createOutputPublisher({dataDir:DATA_DIR,database,store:f.store,artifactScopes:()=>[scope]});
  expect(publisher.beforeDispatch({botId:f.bot.id,threadId:room.threadId,runId,workspaceRoot:realpathSync(root),managed:true})).toBe(true);
  mkdirSync(join(root,"outputs"),{recursive:true});writeFileSync(join(root,"outputs","report.md"),"verified room report");
  const append=vi.spyOn(f.store,"appendMessage").mockImplementationOnce(()=>{throw Error("transcript unavailable");});
  await publisher.publishTerminalOutputs({type:"turn.completed",turnId:"provider-turn",ok:true,threadId:room.threadId,eventId:randomUUID()} as never);append.mockRestore();
  const receipts=outputReceiptsForRun(database(),"shell-output",f.bot.id,room.threadId,runId);expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({stage:"registered",errorCategory:"transcript"});
  if(removed)f.store.patchGroup(room.id,{memberIds:[other.id]});
  const reopened=new Store(()=>({instanceId:"fixture",model:"fixture"})),recovery=createOutputPublisher({dataDir:DATA_DIR,database,store:reopened,artifactScopes:()=>[scope]});await recovery.resumePending();await recovery.resumePending();
  const cards=reopened.messagesFor(room.threadId).filter(message=>message.artifactIds?.length);expect(cards).toHaveLength(removed?0:1);if(!removed)expect(cards[0]!.artifactIds).toEqual([receipts[0]!.artifactId]);
  expect(readFileSync(join(root,"outputs","report.md"),"utf8")).toBe("verified room report");
});

it("the startup resume builds the artifact scopes once per pass, however many registered outputs are owed", async () => {
  const f = fixture(), other = f.store.createBot(), scopes: ArtifactScope[] = [];
  const runsFor = async (rooms: number) => {
    for (let i = 0; i < rooms; i++) {
      const room = f.store.createGroup(`Owed room ${scopes.length}-${i}`, [f.bot.id, other.id]);
      f.store.admitLocalOutputs(f.bot.id, room.threadId);
      const root = ensureTaskWorkspace(f.bot.id, room.threadId), scope = { ...f.taskScope, threadId: room.threadId, workspaceRoot: root }, runId = randomUUID();
      scopes.push(scope);
      const publisher = createOutputPublisher({ dataDir: DATA_DIR, database, store: f.store, artifactScopes: () => [scope] });
      publisher.beforeDispatch({ botId: f.bot.id, threadId: room.threadId, runId, workspaceRoot: realpathSync(root), managed: true });
      mkdirSync(join(root, "outputs"), { recursive: true }); writeFileSync(join(root, "outputs", "report.md"), `report ${i}`);
      const append = vi.spyOn(f.store, "appendMessage").mockImplementationOnce(() => { throw Error("transcript unavailable"); });
      await publisher.publishTerminalOutputs({ type: "turn.completed", turnId: "provider-turn", ok: true, threadId: room.threadId, eventId: randomUUID() } as never); append.mockRestore();
    }
  };
  await runsFor(3);
  let calls = 0;
  const reopened = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  await createOutputPublisher({ dataDir: DATA_DIR, database, store: reopened, artifactScopes: () => { calls++; return scopes; } }).resumePending();
  const three = calls;
  expect(three).toBeGreaterThan(0);
  // the cost does not grow with the owed outputs: a pass with nothing owed builds the same number
  calls = 0;
  await createOutputPublisher({ dataDir: DATA_DIR, database, store: reopened, artifactScopes: () => { calls++; return scopes; } }).resumePending();
  expect(calls).toBeLessThanOrEqual(three);
  expect(three).toBeLessThanOrEqual(2);
});

it.each(["source", "saved", "scope", "conversation"])("does not recover registered shell output with changed %s", async change => {
  const f = fixture(); f.dispatch(); f.write("outputs/report.txt", "verified");
  const append = vi.spyOn(f.store, "appendMessage").mockImplementationOnce(() => { throw new Error("transcript unavailable"); });
  await f.complete(); append.mockRestore();
  if (change === "source") f.write("outputs/report.txt", "modified");
  if (change === "saved") writeFileSync(join(storage(), `${sha("verified")}.txt`), "modified");
  if (change === "scope") f.taskScope.workspaceRoot = join(DATA_DIR, "outside");
  if (change === "conversation") f.taskScope.threadAvailable = false;
  expect((await recoverShell(f))).toEqual([]);
  expect(f.receipts()[0]!.messageId).toBeUndefined();
});

it.each(["failed", "cancelled", "unmanaged"])("does not recover %s shell output", async outcome => {
  const f = fixture(); f.dispatch(outcome !== "unmanaged"); f.write("outputs/report.txt", "partial");
  await f.complete(outcome !== "failed", outcome === "cancelled" ? "cancelled" : undefined);
  expect((await recoverShell(f))).toEqual([]);
  expect(listArtifacts(database(), storage(), {}, f.access).total).toBe(0);
});

it("receipts a native assistant image before attachment and saves it to Files once through the managed root", () => {
  const f = fixture(), db = database();
  const saved = publishAssistantImage({ db, dataDir: DATA_DIR, store: f.store }, { botId: f.bot.id, threadId: f.bot.threadId, runId: "turn-1", bytes: png, mime: "image/png" });
  expect(readFileSync(saved.path)).toEqual(png);
  const [receipt] = outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-1");
  expect(receipt).toMatchObject({ stage: "registered", sha256: sha(png), attachmentId: basename(saved.path) });
  expect(describeArtifact(db, storage(), receipt!.artifactId!, f.access)).toMatchObject({ kind: "image", producer: "assistant-image", sha256: sha(png), threadId: f.bot.threadId, sourceConversationAvailable: true });
  // Neither manual nor tool registration can select the managed image root.
  expect(() => registerArtifact(db, storage(), { botId: f.bot.id, threadId: f.bot.threadId, relativePath: receipt!.pathToken }, { owner: true, scopes: [f.imageScope] })).toThrow("unavailable");
});

it("retains an assistant image whose attachment cannot be stored and completes it at startup without a provider", async () => {
  const f = fixture(), db = database(), deps = { db, dataDir: DATA_DIR, store: f.store };
  faults.saveImage = 1;
  expect(() => publishAssistantImage(deps, { botId: f.bot.id, threadId: f.bot.threadId, runId: "turn-2", bytes: png, mime: "image/png" })).toThrow("kept locally");
  const [receipt] = outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-2");
  expect(receipt).toMatchObject({ stage: "failed", errorCategory: "quota", sha256: sha(png) });
  expect(readFileSync(join(managedImageOutputPath(DATA_DIR, f.bot.id, f.bot.threadId), receipt!.pathToken))).toEqual(png);
  expect(f.store.messagesFor(f.bot.threadId).some(message => message.attachments?.length)).toBe(false);

  expect(await resumePendingAssistantImages(deps)).toBe(1);
  expect(await resumePendingAssistantImages(deps)).toBe(0);
  const attached = f.store.messagesFor(f.bot.threadId).filter(message => message.attachments?.length);
  expect(attached).toHaveLength(1);
  expect(outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-2")).toEqual([expect.objectContaining({ stage: "registered", messageId: attached[0]!.id })]);
  // the receipt's run id is the provider turn that sent the image: the recovered row is that turn's engine output, never a Murage line
  expect(attached[0]).toMatchObject({ turnId: "turn-2" });
  expect(attached[0]!.murageLine).toBeUndefined();
  expect(listArtifacts(db, storage(), { kind: "image" }, f.access).total).toBe(1);
});

it("a generated image row names its producing turn so revoking that turn's inputs withholds it; with no turn it is a Murage line", async () => {
  const f = fixture(), db = database(), deps = { db, dataDir: DATA_DIR, store: f.store };
  const fromTurn = retainImageOutput(deps, { producer: "image-operation", botId: f.bot.id, threadId: f.bot.threadId, runId: "operation-1", bytes: png, mime: "image/png" });
  await completeImageOutput(deps, fromTurn.id, { transcriptText: "Image created.", artifactName: "Generated image", turnId: "prov-1" });
  const noTurn = retainImageOutput(deps, { producer: "image-operation", botId: f.bot.id, threadId: f.bot.threadId, runId: "operation-2", bytes: png, mime: "image/png" });
  await completeImageOutput(deps, noTurn.id, { transcriptText: "Image created.", artifactName: "Generated image" });
  const rows = f.store.messagesFor(f.bot.threadId).filter(message => message.attachments?.length);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ turnId: "prov-1" });
  expect(rows[0]!.murageLine).toBeUndefined();
  expect(rows[1]!.turnId).toBeUndefined();
  expect(rows[1]!.murageLine).toBe(true);
});

it("refuses to complete a retained image into a conversation the producing bot does not own", async () => {
  const f = fixture(), other = f.store.createBot(), db = database(), deps = { db, dataDir: DATA_DIR, store: f.store };
  const receipt = retainImageOutput(deps, { producer: "image-operation", botId: f.bot.id, threadId: other.threadId, runId: "operation", bytes: png, mime: "image/png" });
  await expect(completeImageOutput(deps, receipt.id, { transcriptText: "Image created.", artifactName: "Generated image" })).rejects.toThrow("no longer available");
  expect(f.store.messagesFor(other.threadId).some(message => message.attachments?.length)).toBe(false);
  expect(outputReceiptsForRun(db, "image-operation", f.bot.id, other.threadId, "operation")).toEqual([expect.objectContaining({ stage: "retained" })]);
});

it("re-completes a retained image on a full disk when its committed attachment is identical, and never vouches for one that differs", async () => {
  const f = fixture(), db = database(), deps = { db, dataDir: DATA_DIR, store: f.store };
  const saved = publishAssistantImage(deps, { botId: f.bot.id, threadId: f.bot.threadId, runId: "turn-full", bytes: png, mime: "image/png" });
  const [receipt] = outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-full");
  db.prepare("UPDATE output_publications SET stage='failed',artifact_id=NULL WHERE id=?").run(receipt!.id);
  __setFreeDiskProbeForTests(() => 0);
  try {
    const done = await completeImageOutput(deps, receipt!.id, { artifactName: "Generated image" });
    expect(done.saved).toEqual(saved);
    expect(readFileSync(saved.path)).toEqual(png);
    const other = Buffer.alloc(png.length, 0x77);
    writeFileSync(saved.path, other);
    db.prepare("UPDATE output_publications SET stage='failed',artifact_id=NULL WHERE id=?").run(receipt!.id);
    await expect(completeImageOutput(deps, receipt!.id, { artifactName: "Generated image" })).rejects.toThrow("kept locally");
    expect(readFileSync(saved.path)).toEqual(other);
    expect(outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-full")[0]).toMatchObject({ stage: "failed" });
  } finally { __setFreeDiskProbeForTests(undefined); }
});

it("asks the caller again after the awaited attachment step, before anything is attached", async () => {
  const f = fixture(), db = database(), deps = { db, dataDir: DATA_DIR, store: f.store };
  const receipt = retainImageOutput(deps, { producer: "image-operation", botId: f.bot.id, threadId: f.bot.threadId, runId: "operation-recheck", bytes: png, mime: "image/png" });
  // committed once without a transcript entry, so the next completion reads the entry and would add the message
  await completeImageOutput(deps, receipt.id, { artifactName: "Generated image" });
  const stage = outputReceiptsForRun(db, "image-operation", f.bot.id, f.bot.threadId, "operation-recheck")[0]!.stage;
  const order: string[] = [];
  __setAttachmentReadHookForTests(stage => { if (stage === "before-open") order.push("read"); });
  try {
    await expect(completeImageOutput(deps, receipt.id, { transcriptText: "Image created.", artifactName: "Generated image",
      recheck: () => { order.push("recheck"); throw new Error("revoked"); } })).rejects.toThrow("revoked");
  } finally { __setAttachmentReadHookForTests(undefined); }
  expect(order).toEqual(["read", "recheck"]);
  expect(f.store.messagesFor(f.bot.threadId).some(message => message.attachments?.length)).toBe(false);
  expect(outputReceiptsForRun(db, "image-operation", f.bot.id, f.bot.threadId, "operation-recheck")[0]).toMatchObject({ stage });
});

// Restore fence: a retained image or an unannounced shell output that was pending at backup time does not finish at boot.
it("a fenced pending assistant image is not published by the startup resume; only the owner's explicit release carrying the current restore generation finishes it", async () => {
  const f = fixture(), db = database(), deps = { db, dataDir: DATA_DIR, store: f.store };
  faults.saveImage = 1;
  expect(() => publishAssistantImage(deps, { botId: f.bot.id, threadId: f.bot.threadId, runId: "turn-held", bytes: png, mime: "image/png" })).toThrow("kept locally");
  const [receipt] = outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-held");
  fenceRestoredSql(db, "gen-1");
  expect(sqlRowRestoreHeld(db, "output_receipt", receipt!.id)).toBe(true);
  // every startup publisher
  expect(await resumePendingAssistantImages(deps)).toBe(0);
  await f.publisher.resumePending();
  expect(f.store.messagesFor(f.bot.threadId).some(message => message.attachments?.length)).toBe(false);
  expect(outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-held")[0]).toMatchObject({ stage: "failed" });
  // kept, not dropped: an unrelated message in the conversation releases nothing
  f.dispatch(false);
  expect(sqlRowRestoreHeld(db, "output_receipt", receipt!.id)).toBe(true);
  await f.publisher.resumePending();
  expect(f.store.messagesFor(f.bot.threadId).some(message => message.attachments?.length)).toBe(false);
  // a release without the generation, or with an older one, changes nothing
  expect(releaseHeldItem(db, "output_receipt", receipt!.id, undefined, "gen-1")).toEqual({ ok: false, reason: "stale_generation" });
  expect(releaseHeldItem(db, "output_receipt", receipt!.id, "gen-0", "gen-1")).toEqual({ ok: false, reason: "stale_generation" });
  expect(sqlRowRestoreHeld(db, "output_receipt", receipt!.id)).toBe(true);
  // the explicit, output-specific release for the current generation lets it finish
  expect(releaseHeldItem(db, "output_receipt", receipt!.id, "gen-1", "gen-1")).toEqual({ ok: true });
  await f.publisher.resumePending();
  expect(outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-held")[0]).toMatchObject({ stage: "registered" });
  expect(f.store.messagesFor(f.bot.threadId).filter(message => message.attachments?.length)).toHaveLength(1);
});

it("a fenced registered shell output keeps its unannounced card until the owner releases it explicitly", async () => {
  const f = fixture(); f.dispatch();
  f.write("outputs/report.txt", "verified");
  const append = vi.spyOn(f.store, "appendMessage").mockImplementationOnce(() => { throw new Error("transcript unavailable"); });
  await f.complete(); append.mockRestore();
  fenceRestoredSql(database(), "gen-1");
  expect((await recoverShell(f))).toEqual([]);
  expect(f.receipts()[0]!.messageId).toBeUndefined();
  f.dispatch(false); // an unrelated message announces nothing
  expect((await recoverShell(f))).toEqual([]);
  expect(f.cards()).toHaveLength(0);
  expect(f.receipts()[0]!.messageId).toBeUndefined();
  expect(releaseHeldItem(database(), "output_receipt", f.receipts()[0]!.id, "gen-0", "gen-1")).toMatchObject({ ok: false });
  expect(releaseHeldItem(database(), "output_receipt", f.receipts()[0]!.id, "gen-1", "gen-1")).toEqual({ ok: true });
  await f.publisher.resumePending();
  expect(f.cards()).toHaveLength(1);
  expect(f.receipts()[0]!.messageId).toBe(f.cards()[0]!.id);
});

it("resumes a failed receipt that already names its message without a second image message, even when the thread is not yet filled", async () => {
  const f = fixture(), db = database(), deps = { db, dataDir: DATA_DIR, store: f.store };
  faults.saveImage = 1;
  expect(() => publishAssistantImage(deps, { botId: f.bot.id, threadId: f.bot.threadId, runId: "turn-unfilled", bytes: png, mime: "image/png" })).toThrow("kept locally");
  const [receipt] = outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-unfilled");
  expect(receipt).toMatchObject({ stage: "failed" });
  // the attachment landed earlier (the Files step is what failed): the message exists and the receipt names it
  const first = await resumePendingAssistantImages(deps);
  expect(first).toBe(1);
  const before = f.store.messagesFor(f.bot.threadId).filter(message => message.attachments?.length);
  expect(before).toHaveLength(1);
  db.prepare("UPDATE output_publications SET stage='failed',artifact_id=NULL WHERE id=?").run(receipt!.id);
  // first boot after the upgrade: the branch index of the thread is empty, so "is the image attached" answers no
  const spy = vi.spyOn(f.store, "rowAttaching").mockReturnValue(undefined);
  await resumePendingAssistantImages(deps);
  spy.mockRestore();
  expect(f.store.messagesFor(f.bot.threadId).filter(message => message.attachments?.length)).toHaveLength(1);
});

it("50 earlier held images never starve a released one: the 51st is published by the recovery batch and by its own direct completion", async () => {
  const f = fixture(), db = database(), deps = { db, dataDir: DATA_DIR, store: f.store };
  faults.saveImage = 51;
  for (let i = 0; i < 51; i++) expect(() => publishAssistantImage(deps, { botId: f.bot.id, threadId: f.bot.threadId, runId: `turn-${i}`, bytes: png, mime: "image/png" })).toThrow("kept locally");
  fenceRestoredSql(db, "gen-1");
  const order = (db.prepare("SELECT id FROM output_publications WHERE producer='assistant-image' ORDER BY updated_at,id").all() as Array<{ id: string }>).map(row => row.id);
  expect(order).toHaveLength(51);
  const last = order[50]!, beforeLast = order[49]!;
  expect(await resumePendingAssistantImages(deps)).toBe(0);
  expect(releaseHeldItem(db, "output_receipt", last, "gen-1", "gen-1")).toEqual({ ok: true });
  expect(await resumePendingAssistantImages(deps)).toBe(1);
  expect(db.prepare("SELECT stage FROM output_publications WHERE id=?").get(last)).toEqual({ stage: "registered" });
  // the direct path does not depend on any batch
  await f.publisher.completeReleased(beforeLast);
  expect(db.prepare("SELECT stage FROM output_publications WHERE id=?").get(beforeLast)).toEqual({ stage: "registered" });
  expect(sqlRowRestoreHeld(db, "output_receipt", beforeLast)).toBe(true); // completion alone does not drop the hold; the route does, after success
});

it("a retained shell output is published by the owner's Release, and stays held and listed until the publish succeeds", async () => {
  const f = fixture(), db = database();
  f.dispatch();
  const report = f.write("outputs/report.txt", "kept for the owner");
  await f.complete(false); // a failed turn keeps a verified receipt only
  const [receipt] = f.receipts();
  expect(receipt).toMatchObject({ stage: "retained" });
  fenceRestoredSql(db, "gen-1");
  expect(sqlRowRestoreHeld(db, "output_receipt", receipt!.id)).toBe(true);
  await f.publisher.resumePending();
  expect(f.cards()).toHaveLength(0);
  // the file is gone: the release cannot finish, so the hold (and the list entry) stays
  const original = readFileSync(report);
  rmSync(report);
  expect(checkHeldRelease(db, "output_receipt", receipt!.id, "gen-1", "gen-1")).toEqual({ ok: true });
  await expect(f.publisher.completeReleased(receipt!.id)).rejects.toThrow();
  expect(sqlRowRestoreHeld(db, "output_receipt", receipt!.id)).toBe(true);
  expect(f.receipts()[0]).toMatchObject({ stage: "retained" });
  expect(f.cards()).toHaveLength(0);
  // retry with the file back: published, announced once, then the hold is dropped
  writeFileSync(report, original);
  await f.publisher.completeReleased(receipt!.id);
  expect(releaseRestoreHold(db, "output_receipt", receipt!.id)).toBe(true);
  expect(f.receipts()[0]).toMatchObject({ stage: "registered" });
  expect(f.receipts()[0]!.messageId).toBe(f.cards()[0]!.id);
  expect(f.cards()).toHaveLength(1);
  expect(listArtifacts(db, storage(), {}, f.access).total).toBe(1);
  await f.publisher.completeReleased(receipt!.id); // idempotent
  expect(f.cards()).toHaveLength(1);
});

it("registered shell runs: 55 held runs ahead never starve a released run's card recovery", async () => {
  const f = fixture(), db = database();
  for (let i = 0; i < 55; i++) db.prepare("INSERT INTO output_publications(id,producer,bot_id,thread_id,run_id,path_token,sha256,mime,bytes,stage,artifact_id,created_at,updated_at) VALUES(?,'shell-output','b','t',?,?,?,'text/plain',1,'registered','art',?,?)")
    .run(`held-${i}`, `run-${i}`, `outputs/${i}.txt`, "a".repeat(64), i + 1, i + 1);
  f.dispatch(); f.write("outputs/real.txt", "verified");
  const append = vi.spyOn(f.store, "appendMessage").mockImplementationOnce(() => { throw new Error("transcript unavailable"); });
  await f.complete(); append.mockRestore();
  db.prepare("UPDATE output_publications SET created_at=1000000 WHERE run_id=?").run(f.runId);
  fenceRestoredSql(db, "gen-1");
  for (const receipt of f.receipts()) releaseRestoreHold(db, "output_receipt", receipt.id);
  await f.publisher.resumePending();
  expect(f.cards()).toHaveLength(1);
});

it("the Release route finishes the receipt first and drops the hold only afterwards", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const route = source.slice(source.indexOf("restore-holds\\/(output_receipt|shared_result)"), source.indexOf("held-continuations"));
  expect(route.indexOf("checkHeldRelease")).toBeGreaterThan(-1);
  expect(route.indexOf("outputPublisher.completeReleased(rowId)")).toBeGreaterThan(route.indexOf("checkHeldRelease"));
  expect(route.indexOf("releaseRestoreHold(db, kind, rowId)")).toBeGreaterThan(route.indexOf("outputPublisher.completeReleased(rowId)"));
});

// Astra r11 P2: a Release must never drop the hold before the output is truly published, Files copy included.
it("a Release whose Files copy hits the quota throws, keeps the hold and the receipt, and the retry publishes", async () => {
  const f = fixture(), db = database(), deps = { db, dataDir: DATA_DIR, store: f.store };
  faults.saveImage = 1;
  expect(() => publishAssistantImage(deps, { botId: f.bot.id, threadId: f.bot.threadId, runId: "turn-quota", bytes: png, mime: "image/png" })).toThrow("kept locally");
  fenceRestoredSql(db, "gen-1");
  const [held] = outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-quota");
  expect(sqlRowRestoreHeld(db, "output_receipt", held!.id)).toBe(true);
  faults.register = 1; // the attachment now succeeds, the Files copy does not
  await expect(f.publisher.completeReleased(held!.id)).rejects.toThrow();
  expect(sqlRowRestoreHeld(db, "output_receipt", held!.id)).toBe(true); // still held and listed
  expect(outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-quota")[0]).toMatchObject({ stage: "failed", errorCategory: "quota" });
  expect(listArtifacts(db, storage(), { kind: "image" }, f.access).total).toBe(0);
  // the owner releases again: Files has room, the copy lands once and the receipt is registered
  await f.publisher.completeReleased(held!.id);
  expect(outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-quota")[0]).toMatchObject({ stage: "registered", artifactId: expect.any(String) });
  expect(listArtifacts(db, storage(), { kind: "image" }, f.access).total).toBe(1);
  expect(f.store.messagesFor(f.bot.threadId).filter(message => message.attachments?.length)).toHaveLength(1);
});

it("the Release route answers 409 and leaves the hold when completion throws", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const route = source.slice(source.indexOf("restore-holds\\/(output_receipt|shared_result)"), source.indexOf("held-continuations"));
  expect(route).toMatch(/catch \{ return json\(res, 409, \{ error: "This output is still kept and was not published yet\. Release it again to retry\." \}\); \}/);
});

// 1.0.4 (rig, Flux): a hand-off bot writes into the project lead's outputs/, and two members share one conversation. Neither was
// saved to Files: the delegate's snapshot covered only its own desk, and a second dispatch on a conversation dropped the first's.
function projectFixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const lead = store.createBot(), delegate = store.createBot();
  const leadRoot = ensureTaskWorkspace(lead.id, lead.threadId), delegateRoot = ensureTaskWorkspace(delegate.id, delegate.threadId);
  const scope = (bot: typeof lead, root: string, threadId = bot.threadId): ArtifactScope => ({ botId: bot.id, botName: bot.name, threadId, workspaceRoot: root });
  const scopes = [scope(lead, leadRoot), scope(delegate, delegateRoot), scope(delegate, delegateRoot, lead.threadId)];
  const turns = new Map<string, string>();
  const publisher = createOutputPublisher({ dataDir: DATA_DIR, database, store, artifactScopes: () => scopes, turnOfRun: (_thread, run) => turns.get(run) });
  const access = { owner: true, scopes };
  const complete = (threadId: string, turnId: string) => publisher.publishTerminalOutputs({ type: "turn.completed", turnId, ok: true, threadId, eventId: randomUUID() } as never);
  const write = (root: string, relativePath: string, content: string) => { const path = join(root, ...relativePath.split("/")); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  return { store, lead, delegate, leadRoot, delegateRoot, publisher, access, turns, complete, write };
}

it("saves a hand-off bot's file written into the lead's outputs/ and shows it in Files", async () => {
  const f = projectFixture();
  const run = randomUUID(); f.turns.set(run, "delegate-turn");
  f.publisher.beforeDispatch({ botId: f.delegate.id, threadId: f.delegate.threadId, runId: run, workspaceRoot: realpathSync(f.delegateRoot), managed: true,
    siblings: [{ botId: f.lead.id, threadId: f.lead.threadId, workspaceRoot: realpathSync(f.leadRoot) }] });
  f.write(f.leadRoot, "outputs/delgado-plan.md", "# Plan\nFive pages.");
  await f.complete(f.delegate.threadId, "delegate-turn");
  const items = listArtifacts(database(), storage(), {}, f.access).items;
  expect(items.map(item => [item.botId, item.relativePath])).toEqual([[f.lead.id, "outputs/delgado-plan.md"]]);
  expect(f.store.messagesFor(f.lead.threadId).filter(message => message.artifactIds?.length).map(message => message.text)).toEqual(["Saved file: delgado-plan.md"]);
});

it("keeps a new saved copy when a hand-off bot overwrites a file the lead already saved", async () => {
  const f = projectFixture();
  const first = randomUUID(); f.turns.set(first, "lead-turn");
  f.publisher.beforeDispatch({ botId: f.lead.id, threadId: f.lead.threadId, runId: first, workspaceRoot: realpathSync(f.leadRoot), managed: true });
  f.write(f.leadRoot, "outputs/plan.md", "version one");
  await f.complete(f.lead.threadId, "lead-turn");
  const second = randomUUID(); f.turns.set(second, "delegate-turn");
  f.publisher.beforeDispatch({ botId: f.delegate.id, threadId: f.delegate.threadId, runId: second, workspaceRoot: realpathSync(f.delegateRoot), managed: true,
    siblings: [{ botId: f.lead.id, threadId: f.lead.threadId, workspaceRoot: realpathSync(f.leadRoot) }] });
  f.write(f.leadRoot, "outputs/plan.md", "version two, longer");
  await f.complete(f.delegate.threadId, "delegate-turn");
  const items = listArtifacts(database(), storage(), {}, f.access).items;
  expect(items).toHaveLength(2);
  expect(new Set(items.map(item => item.sha256))).toEqual(new Set([sha("version one"), sha("version two, longer")]));
});

it("keeps each member's snapshot when two bots dispatch on one conversation", async () => {
  const f = projectFixture();
  const a = randomUUID(), b = randomUUID(); f.turns.set(a, "turn-a"); f.turns.set(b, "turn-b");
  f.publisher.beforeDispatch({ botId: f.lead.id, threadId: f.lead.threadId, runId: a, workspaceRoot: realpathSync(f.leadRoot), managed: true });
  f.publisher.beforeDispatch({ botId: f.delegate.id, threadId: f.lead.threadId, runId: b, workspaceRoot: realpathSync(f.delegateRoot), managed: true });
  f.write(f.leadRoot, "outputs/lead.md", "from the lead");
  f.write(f.delegateRoot, "outputs/delegate.md", "from the delegate");
  await f.complete(f.lead.threadId, "turn-a");
  await f.complete(f.lead.threadId, "turn-b");
  expect(listArtifacts(database(), storage(), {}, f.access).items.map(item => item.relativePath).sort()).toEqual(["outputs/delegate.md", "outputs/lead.md"]);
});
