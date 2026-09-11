// IMG-SEED (F5-T4, media design M4): uploaded, generated, saved and workspace
// images resolve through one exact-byte reference flow, all-or-nothing and
// before any approval or billing. A numeric seed is never a substitute.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { initializeArtifacts, registerArtifact, type ArtifactScope } from "./artifacts.ts";
import { __resetMediaAssetsForTests, mediaAssetsRoute, mediaWorkspaceRevision, type MediaAssetsDeps } from "./media-assets.ts";
import { conversationImageAttachments, resolveImageReferenceRoute } from "./image-reference-resolver.ts";
import { imageReferences } from "./image-operations.ts";
import type { DelegatedRequest, DelegatedResult } from "./route-delegation.ts";
import { Store } from "./store.ts";
import { COMPANION_HEADER } from "./sse-visibility.ts";
import { composeMessage } from "../src/lib/composer-attachments.ts";
import { MEDIA_ROUTES, type MediaReferenceResponse, type ResolveImageReferenceResponse } from "../shared/media-assets.ts";

// Attachment storage fault injection for the rollback case.
const faults = vi.hoisted(() => ({ saveImageAfter: -1 }));
vi.mock("./attachments.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./attachments.ts")>();
  return { ...actual, saveImage: (...args: Parameters<typeof actual.saveImage>) => {
    if (faults.saveImageAfter === 0) throw Object.assign(new Error("attachments storage is full"), { status: 507 });
    if (faults.saveImageAfter > 0) faults.saveImageAfter--;
    return actual.saveImage(...args);
  } };
});

const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
/** A structurally valid PNG head (signature + IHDR); `fill` makes bytes distinct. */
const png = (fill = 0x11, tail = 64, width = 3, height = 2) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0]), u32(0),
  Buffer.alloc(tail, fill), Buffer.from("IEND"),
]);
const gif = () => Buffer.concat([Buffer.from("GIF89a"), Buffer.from([7, 0, 9, 0, 0, 0, 0]), Buffer.alloc(32, 0x21), Buffer.from([0x3b])]);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

interface Fixture {
  deps: MediaAssetsDeps; store: Store; db: DatabaseSync; attachments: string; storage: string; root: string;
  botId: string; threadId: string; otherBotId: string; otherThreadId: string;
}
const cleanups: Array<() => void> = [];
beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); faults.saveImageAfter = -1; __resetMediaAssetsForTests(); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* best effort */ } } });

function fixture(): Fixture {
  const store = new Store(selection);
  const bot = store.createBot({ name: "Reference bot" }), other = store.createBot({ name: "Other bot" });
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "murage-imgref-db-")), "messages.db")); cleanups.push(() => db.close()); initializeArtifacts(db);
  const attachments = join(DATA_DIR, "attachments"), workspaces = join(DATA_DIR, "workspaces"), storage = join(DATA_DIR, "artifact-files");
  mkdirSync(attachments, { recursive: true });
  for (const item of [bot, other]) mkdirSync(join(workspaces, item.id), { recursive: true });
  // Mirrors server/index.ts artifactScopes: the task workspace plus the
  // managed generated-images scope R3-T4 adds for every conversation.
  const artifactScopes = (): ArtifactScope[] => store.bots.flatMap(item => [
    { botId: item.id, botName: item.name, threadId: item.threadId, workspaceRoot: join(workspaces, item.id) },
    { botId: item.id, botName: item.name, threadId: item.threadId, workspaceRoot: join(workspaces, item.id, "generated-images", item.threadId), managedOutput: true },
  ]);
  return { deps: { dataDir: DATA_DIR, database: () => db, store, artifactScopes }, store, db, attachments, storage, root: join(workspaces, bot.id),
    botId: bot.id, threadId: bot.threadId, otherBotId: other.id, otherThreadId: other.threadId };
}
/** A generated image: a harness-stored attachment on a bot message. */
function generated(f: Fixture, threadId: string, name: string, bytes: Buffer): string {
  const path = join(f.attachments, name); writeFileSync(path, bytes);
  f.store.appendMessage(threadId, { role: "bot", kind: "text", text: "Image created.", attachments: [{ kind: "image", path, mime: "image/png" }] });
  return path;
}
/** An upload: the composer writes an <attached-image path> tag into the user's message. */
function uploaded(f: Fixture, threadId: string, name: string, bytes: Buffer, role: "user" | "bot" = "user"): string {
  const path = join(f.attachments, name); writeFileSync(path, bytes);
  f.store.appendMessage(threadId, { role, kind: "text", text: composeMessage("Use this", [{ kind: "image", id: "chip", path, name, size: bytes.length, mime: "image/png" }]) });
  return path;
}
function request(method: string, path: string, body?: unknown, options: { desktop?: boolean; headers?: Record<string, string> } = {}): DelegatedRequest {
  return { method, path, url: new URL(`http://127.0.0.1:1${path}`), headers: options.headers ?? {}, desktop: options.desktop ?? false, readBody: async () => body };
}
const claim = (f: Fixture, threadId = f.threadId, botId = f.botId) => ({ botId, threadId, generation: "turn-1" });
const internal = (f: Fixture, body: unknown, who = claim(f)) => resolveImageReferenceRoute(request("POST", "/api/internal/resolve-image-reference", body), who, f.deps);
const desktop = (f: Fixture, body: unknown, options: { desktop?: boolean; headers?: Record<string, string> } = {}) =>
  mediaAssetsRoute(request("POST", MEDIA_ROUTES.reference, body, { desktop: true, ...options }), f.deps);
const ok = (result: DelegatedResult) => { expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body as ResolveImageReferenceResponse; };
const refusal = (result: DelegatedResult, status: number, code: string, index?: number) => {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
  expect(result.body).toMatchObject({ code, ...(index === undefined ? {} : { index }) });
  expect((result.body as { error: string }).error).toContain("No reference image was prepared.");
};
const attachmentFiles = (f: Fixture) => readdirSync(f.attachments).filter(name => !name.startsWith(".")).sort();
const revisionOf = async (f: Fixture, relativePath: string) => {
  const fs = await import("node:fs");
  return mediaWorkspaceRevision(fs.realpathSync.native(f.root), relativePath, fs.lstatSync(join(f.root, relativePath)));
};

describe("resolve-image-reference: one exact-byte flow", () => {
  it("resolves an upload, a generated image, a saved Files image and a workspace file of this conversation", async () => {
    const f = fixture();
    const upload = png(0x21), made = png(0x22), work = png(0x23), saved = png(0x24);
    uploaded(f, f.threadId, "11111111-1111-4111-8111-111111111111.png", upload);
    generated(f, f.threadId, "22222222-2222-4222-8222-222222222222.png", made);
    mkdirSync(join(f.root, "refs")); writeFileSync(join(f.root, "refs", "sketch one.png"), work);
    writeFileSync(join(f.root, "board.png"), saved);
    const artifact = registerArtifact(f.db, f.storage, { botId: f.botId, threadId: f.threadId, relativePath: "board.png" }, { owner: true, scopes: f.deps.artifactScopes() });
    const before = f.store.messagesFor(f.threadId).length;

    const result = ok(await internal(f, { sources: [
      { kind: "attachment", attachmentId: "11111111-1111-4111-8111-111111111111.png" },
      { kind: "attachment", attachmentId: "22222222-2222-4222-8222-222222222222.png" },
      { kind: "workspace", relativePath: "refs/sketch one.png", revision: await revisionOf(f, "refs/sketch one.png") },
      { kind: "artifact", artifactId: artifact.id, sha256: artifact.sha256 },
    ] }));
    const [a, b, c, d] = result.references;
    expect(result.reference).toBeUndefined();
    // Conversation attachments are referenced as they are; nothing is copied.
    expect(a).toEqual({ id: "11111111-1111-4111-8111-111111111111.png", sha256: sha256(upload), mime: "image/png", bytes: upload.length, source: "attachment", width: 3, height: 2 });
    expect(b).toMatchObject({ id: "22222222-2222-4222-8222-222222222222.png", sha256: sha256(made), source: "attachment" });
    // Workspace and saved bytes are pinned into new attachments of this conversation.
    expect(c).toMatchObject({ sha256: sha256(work), bytes: work.length, source: "workspace" });
    expect(d).toMatchObject({ sha256: sha256(saved), bytes: saved.length, source: "artifact" });
    for (const ref of [c!, d!]) expect(ref.id).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(readFileSync(join(f.attachments, c!.id)).equals(work)).toBe(true);
    expect(readFileSync(join(f.attachments, d!.id)).equals(saved)).toBe(true);
    // The owner sees what was prepared, before any approval; no absolute root leaks.
    const messages = f.store.messagesFor(f.threadId);
    expect(messages).toHaveLength(before + 1);
    const disclosure = messages.at(-1)!;
    expect(disclosure.text).toContain("Nothing is generated or billed until you approve");
    expect(disclosure.text).toContain("refs/sketch one.png");
    expect(disclosure.attachments?.map(item => item.path)).toEqual([join(f.attachments, c!.id), join(f.attachments, d!.id)]);
    expect(JSON.stringify(result)).not.toContain(f.root);
    // generate_image's allowlist accepts every id and reads back the exact bytes.
    expect(imageReferences(f.store, f.threadId, result.references.map(ref => ref.id)).map(ref => sha256(ref.bytes))).toEqual([upload, made, work, saved].map(sha256));
  });

  it("answers the single-source form and pins a workspace file with or without a revision", async () => {
    const f = fixture(), work = png(0x31);
    writeFileSync(join(f.root, "a.png"), work);
    const single = ok(await internal(f, { source: { kind: "workspace", relativePath: "a.png" } }));
    expect(single.reference).toEqual(single.references[0]);
    expect(single.reference).toMatchObject({ sha256: sha256(work), source: "workspace" });
  });

  it("reuses the conversation's existing attachment when saved or workspace bytes are already in it", async () => {
    const f = fixture(), made = png(0x41);
    generated(f, f.threadId, "33333333-3333-4333-8333-333333333333.png", made);
    writeFileSync(join(f.root, "copy.png"), made);
    writeFileSync(join(f.root, "twin-a.png"), png(0x42)); writeFileSync(join(f.root, "twin-b.png"), png(0x42));
    const artifact = registerArtifact(f.db, f.storage, { botId: f.botId, threadId: f.threadId, relativePath: "copy.png" }, { owner: true, scopes: f.deps.artifactScopes() });
    const files = attachmentFiles(f);
    const first = ok(await internal(f, { sources: [{ kind: "artifact", artifactId: artifact.id, sha256: artifact.sha256 }, { kind: "workspace", relativePath: "copy.png" }] }));
    expect(first.references.map(ref => ref.id)).toEqual(["33333333-3333-4333-8333-333333333333.png", "33333333-3333-4333-8333-333333333333.png"]);
    expect(attachmentFiles(f)).toEqual(files);
    // Identical bytes inside one request are stored once.
    const twins = ok(await internal(f, { sources: [{ kind: "workspace", relativePath: "twin-a.png" }, { kind: "workspace", relativePath: "twin-b.png" }] }));
    expect(twins.references[0]!.id).toBe(twins.references[1]!.id);
    expect(attachmentFiles(f)).toHaveLength(files.length + 1);
  });
});

describe("resolve-image-reference: all or nothing, before approval", () => {
  it("prepares nothing when any one source fails", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "good.png"), png(0x51));
    generated(f, f.otherThreadId, "44444444-4444-4444-8444-444444444444.png", png(0x52));
    const files = attachmentFiles(f), messages = f.store.messagesFor(f.threadId).length;
    refusal(await internal(f, { sources: [{ kind: "workspace", relativePath: "good.png" }, { kind: "attachment", attachmentId: "44444444-4444-4444-8444-444444444444.png" }] }), 404, "unavailable", 1);
    refusal(await internal(f, { sources: [{ kind: "workspace", relativePath: "good.png" }, { kind: "workspace", relativePath: "absent.png" }] }), 410, "missing", 1);
    refusal(await internal(f, { sources: [{ kind: "workspace", relativePath: "good.png" }, { kind: "workspace", relativePath: "/etc/passwd" }] }), 400, "invalid-request", 1);
    expect(attachmentFiles(f)).toEqual(files);
    expect(f.store.messagesFor(f.threadId)).toHaveLength(messages);
  });

  it("removes what it stored when attachment storage fails part way", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "one.png"), png(0x61)); writeFileSync(join(f.root, "two.png"), png(0x62));
    const files = attachmentFiles(f), messages = f.store.messagesFor(f.threadId).length;
    faults.saveImageAfter = 1;
    refusal(await internal(f, { sources: [{ kind: "workspace", relativePath: "one.png" }, { kind: "workspace", relativePath: "two.png" }] }), 507, "storage", 1);
    expect(attachmentFiles(f)).toEqual(files);
    expect(f.store.messagesFor(f.threadId)).toHaveLength(messages);
  });

  it("enforces four references, 10 MiB each and 20 MiB together", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "a.png"), png(0x71));
    refusal(await internal(f, { sources: Array.from({ length: 5 }, () => ({ kind: "workspace", relativePath: "a.png" })) }), 400, "invalid-request");
    refusal(await internal(f, { sources: [] }), 400, "invalid-request");
    refusal(await internal(f, { source: { kind: "workspace", relativePath: "a.png" }, sources: [] }), 400, "invalid-request");
    writeFileSync(join(f.root, "huge.png"), png(0x72, 10 * 1024 * 1024));
    refusal(await internal(f, { source: { kind: "workspace", relativePath: "huge.png" } }), 413, "too-large", 0);
    const seven = 7 * 1024 * 1024;
    for (const name of ["x.png", "y.png", "z.png"]) writeFileSync(join(f.root, name), png(name.charCodeAt(0), seven));
    refusal(await internal(f, { sources: ["x.png", "y.png", "z.png"].map(relativePath => ({ kind: "workspace", relativePath })) }), 413, "too-large", 2);
  });
});

describe("resolve-image-reference: authority", () => {
  it("never crosses conversations and never trusts a bot's text", async () => {
    const f = fixture(), foreign = png(0x81);
    generated(f, f.otherThreadId, "55555555-5555-4555-8555-555555555555.png", foreign);
    uploaded(f, f.threadId, "66666666-6666-4666-8666-666666666666.png", png(0x82), "bot");
    refusal(await internal(f, { source: { kind: "attachment", attachmentId: "55555555-5555-4555-8555-555555555555.png" } }), 404, "unavailable", 0);
    refusal(await internal(f, { source: { kind: "attachment", attachmentId: "66666666-6666-4666-8666-666666666666.png" } }), 404, "unavailable", 0);
    expect(conversationImageAttachments(f.store, f.threadId, f.attachments).has("66666666-6666-4666-8666-666666666666.png")).toBe(false);
    // A saved file of another conversation, or a changed version, is refused.
    writeFileSync(join(f.root, "..", f.otherBotId, "theirs.png"), foreign);
    const theirs = registerArtifact(f.db, f.storage, { botId: f.otherBotId, threadId: f.otherThreadId, relativePath: "theirs.png" }, { owner: true, scopes: f.deps.artifactScopes() });
    refusal(await internal(f, { source: { kind: "artifact", artifactId: theirs.id, sha256: theirs.sha256 } }), 404, "unavailable", 0);
    writeFileSync(join(f.root, "mine.png"), png(0x83));
    const mine = registerArtifact(f.db, f.storage, { botId: f.botId, threadId: f.threadId, relativePath: "mine.png" }, { owner: true, scopes: f.deps.artifactScopes() });
    refusal(await internal(f, { source: { kind: "artifact", artifactId: mine.id, sha256: "0".repeat(64) } }), 409, "changed", 0);
    // The other bot's workspace is not this conversation's workspace.
    writeFileSync(join(f.root, "..", f.otherBotId, "secret.png"), png(0x84));
    refusal(await internal(f, { source: { kind: "workspace", relativePath: "secret.png" } }), 410, "missing", 0);
    // An identity the capability does not match is refused outright.
    refusal(await internal(f, { source: { kind: "workspace", relativePath: "mine.png" } }, claim(f, f.threadId, f.otherBotId)), 404, "unavailable");
  });

  it.skipIf(process.platform === "win32")("refuses links, private files, changed revisions and files that are not images", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "real.png"), png(0x91));
    const outside = mkdtempSync(join(tmpdir(), "murage-imgref-outside-")); cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "x.png"), png(0x92));
    symlinkSync(join(outside, "x.png"), join(f.root, "linked.png"));
    symlinkSync(outside, join(f.root, "linked-dir"));
    mkdirSync(join(f.root, "memory")); writeFileSync(join(f.root, "memory", "face.png"), png(0x93));
    refusal(await internal(f, { source: { kind: "workspace", relativePath: "linked.png" } }), 403, "denied", 0);
    refusal(await internal(f, { source: { kind: "workspace", relativePath: "linked-dir/x.png" } }), 403, "denied", 0);
    refusal(await internal(f, { source: { kind: "workspace", relativePath: "memory/face.png" } }), 403, "denied", 0);
    refusal(await internal(f, { source: { kind: "workspace", relativePath: "../x.png" } }), 400, "invalid-request", 0);
    const revision = await revisionOf(f, "real.png");
    writeFileSync(join(f.root, "real.png"), png(0x94, 80));
    refusal(await internal(f, { source: { kind: "workspace", relativePath: "real.png", revision } }), 409, "changed", 0);
    writeFileSync(join(f.root, "anim.gif"), gif());
    refusal(await internal(f, { source: { kind: "workspace", relativePath: "anim.gif" } }), 415, "unsupported", 0);
    writeFileSync(join(f.root, "renamed.png"), "not an image at all");
    refusal(await internal(f, { source: { kind: "workspace", relativePath: "renamed.png" } }), 415, "unsupported", 0);
    writeFileSync(join(f.root, "damaged.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    refusal(await internal(f, { source: { kind: "workspace", relativePath: "damaged.png" } }), 415, "unsupported", 0);
    // Numeric seeds, URLs and absolute paths are not sources.
    for (const source of [{ kind: "seed", value: 42 }, { kind: "attachment", attachmentId: "https://example.test/a.png" }, { kind: "workspace", relativePath: "C:\\x.png" }, 42]) {
      refusal(await internal(f, { source }), 400, "invalid-request", 0);
    }
  });
});

describe("desktop Use as reference", () => {
  it("pins the image into the named conversation without a transcript entry and only for the desktop", async () => {
    const f = fixture(), upload = png(0xa1);
    const path = uploaded(f, f.threadId, "77777777-7777-4777-8777-777777777777.png", upload);
    writeFileSync(join(f.root, "draft.png"), png(0xa2));
    const artifact = registerArtifact(f.db, f.storage, { botId: f.botId, threadId: f.threadId, relativePath: "draft.png" }, { owner: true, scopes: f.deps.artifactScopes() });
    const messages = f.store.messagesFor(f.threadId).length;
    const source = { kind: "attachment", attachmentId: "77777777-7777-4777-8777-777777777777.png" };
    expect((await desktop(f, { threadId: f.threadId, source }, { desktop: false })).status).toBe(404);
    expect((await desktop(f, { threadId: f.threadId, source }, { headers: { [COMPANION_HEADER]: "1" } })).status).toBe(404);
    expect((await mediaAssetsRoute(request("GET", MEDIA_ROUTES.reference, undefined, { desktop: true }), f.deps)).status).toBe(405);
    const attached = await desktop(f, { threadId: f.threadId, source });
    expect(attached.status).toBe(200);
    expect(attached.body).toEqual({ reference: expect.objectContaining({ id: "77777777-7777-4777-8777-777777777777.png", sha256: sha256(upload) }),
      attachment: { path, name: "77777777-7777-4777-8777-777777777777.png", mime: "image/png", bytes: upload.length } } satisfies MediaReferenceResponse);
    const saved = (await desktop(f, { threadId: f.threadId, source: { kind: "artifact", artifactId: artifact.id, sha256: artifact.sha256 } })).body as MediaReferenceResponse;
    expect(readFileSync(saved.attachment.path).equals(png(0xa2))).toBe(true);
    expect(f.store.messagesFor(f.threadId)).toHaveLength(messages);
    // The named conversation must hold the image.
    refusal(await desktop(f, { threadId: f.otherThreadId, source }), 404, "unavailable", 0);
    refusal(await desktop(f, { threadId: f.otherThreadId, source: { kind: "artifact", artifactId: artifact.id, sha256: artifact.sha256 } }), 404, "unavailable", 0);
    refusal(await desktop(f, { threadId: "no-such-thread", source }), 404, "unavailable");
    refusal(await desktop(f, { threadId: f.threadId, source, path: "/tmp/x.png" }), 400, "invalid-request");
  });

  it("asks which member's workspace holds a room file", async () => {
    const f = fixture();
    const room = f.store.createGroup("Studio", [f.botId, f.otherBotId]);
    writeFileSync(join(f.root, "pic.png"), png(0xb1));
    const roomScopes = { ...f.deps, artifactScopes: () => [...f.deps.artifactScopes(), { botId: f.botId, botName: "Reference bot", threadId: room.threadId, workspaceRoot: f.root }] };
    const call = (body: unknown) => mediaAssetsRoute(request("POST", MEDIA_ROUTES.reference, body, { desktop: true }), roomScopes);
    refusal(await call({ threadId: room.threadId, source: { kind: "workspace", relativePath: "pic.png" } }), 400, "invalid-request");
    expect((await call({ threadId: room.threadId, botId: f.botId, source: { kind: "workspace", relativePath: "pic.png" } })).status).toBe(200);
    refusal(await call({ threadId: room.threadId, botId: "not-a-member", source: { kind: "workspace", relativePath: "pic.png" } }), 404, "unavailable");
  });
});
