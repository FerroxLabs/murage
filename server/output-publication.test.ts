import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { ARTIFACT_PREVIEW_MAX_BYTES, ARTIFACT_TEXT_EXTENSIONS, describeArtifact, listArtifacts, previewArtifact, registerArtifact, type ArtifactScope } from "./artifacts.ts";
import { ensureTaskWorkspace } from "./workspace.ts";
import {
  completeImageOutput, createOutputPublisher, managedImageOutputPath, outputReceiptsForRun, publishAssistantImage, resumePendingAssistantImages, retainImageOutput,
} from "./output-publication.ts";

const faults = vi.hoisted(() => ({ saveImage: 0 }));
vi.mock("./attachments.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./attachments.ts")>();
  return { ...actual, saveImage: (...args: Parameters<typeof actual.saveImage>) => {
    if (faults.saveImage > 0) { faults.saveImage--; throw Object.assign(new Error("attachments storage is full"), { status: 507 }); }
    return actual.saveImage(...args);
  } };
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const storage = () => join(DATA_DIR, "artifact-files");

beforeEach(() => { faults.saveImage = 0; closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
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
  const complete = (ok = true, stopReason?: string) => publisher.publishTerminalOutputs({ type: "turn.completed", ok, ...(stopReason ? { stopReason } : {}), threadId: bot.threadId, eventId: randomUUID() } as never);
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

it("retains an assistant image whose attachment cannot be stored and completes it at startup without a provider", () => {
  const f = fixture(), db = database(), deps = { db, dataDir: DATA_DIR, store: f.store };
  faults.saveImage = 1;
  expect(() => publishAssistantImage(deps, { botId: f.bot.id, threadId: f.bot.threadId, runId: "turn-2", bytes: png, mime: "image/png" })).toThrow("kept locally");
  const [receipt] = outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-2");
  expect(receipt).toMatchObject({ stage: "failed", errorCategory: "quota", sha256: sha(png) });
  expect(readFileSync(join(managedImageOutputPath(DATA_DIR, f.bot.id, f.bot.threadId), receipt!.pathToken))).toEqual(png);
  expect(f.store.messagesFor(f.bot.threadId).some(message => message.attachments?.length)).toBe(false);

  expect(resumePendingAssistantImages(deps)).toBe(1);
  expect(resumePendingAssistantImages(deps)).toBe(0);
  const attached = f.store.messagesFor(f.bot.threadId).filter(message => message.attachments?.length);
  expect(attached).toHaveLength(1);
  expect(outputReceiptsForRun(db, "assistant-image", f.bot.id, f.bot.threadId, "turn-2")).toEqual([expect.objectContaining({ stage: "registered", messageId: attached[0]!.id })]);
  expect(listArtifacts(db, storage(), { kind: "image" }, f.access).total).toBe(1);
});

it("refuses to complete a retained image into a conversation the producing bot does not own", () => {
  const f = fixture(), other = f.store.createBot(), db = database(), deps = { db, dataDir: DATA_DIR, store: f.store };
  const receipt = retainImageOutput(deps, { producer: "image-operation", botId: f.bot.id, threadId: other.threadId, runId: "operation", bytes: png, mime: "image/png" });
  expect(() => completeImageOutput(deps, receipt.id, { transcriptText: "Image created.", artifactName: "Generated image" })).toThrow("no longer available");
  expect(f.store.messagesFor(other.threadId).some(message => message.attachments?.length)).toBe(false);
  expect(outputReceiptsForRun(db, "image-operation", f.bot.id, other.threadId, "operation")).toEqual([expect.objectContaining({ stage: "retained" })]);
});
