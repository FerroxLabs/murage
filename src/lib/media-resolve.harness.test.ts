// F5-T3 joined proof: the renderer's three questions (src/lib/media-resolve.ts)
// asked of the real 0.1.52 route modules — R3-T1 workspace discovery and the
// F5-T1 media resolver and byte route — with real files in a temporary
// workspace. media-resolve.test.ts drives the resolver against a recording
// fake; this file proves the fake tells the truth: the query names, the
// revision discovery issues, the ref shape resolve accepts and the bytes the
// player then streams all line up, and every refusal the design promises
// (outside the workspace, a link, a renamed executable, a container with no
// player, a file that changed) ends in the state the card shows for it.
//
// No harness process, provider, network or real data directory: the route
// functions are called directly with the same DelegatedRequest shape
// server/index.ts hands them, and `desktop: true` because the desktop proof
// is index.ts's decision, not these modules'.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArtifactScope } from "../../server/artifacts.ts";
import { __resetMediaAssetsForTests, mediaAssetsRoute, type MediaAssetsDeps } from "../../server/media-assets.ts";
import { managedImageOutputPath } from "../../server/output-publication.ts";
import type { DelegatedRequest, DelegatedResult } from "../../server/route-delegation.ts";
import { workspaceFilesRoute, type WorkspaceFilesDeps } from "../../server/workspace-files.ts";
import { MEDIA_ROUTES } from "../../shared/media-assets.ts";
import { WORKSPACE_FILES_ROUTES } from "../../shared/workspace-files.ts";
import { forgetLocalMedia, localMedia, resolveLocalMedia, type MediaApi } from "./media-resolve.ts";

// ── bytes ────────────────────────────────────────────────────────────────
const le16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
const le32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
/** A real 8-bit mono PCM WAV of `seconds` at 8 kHz. */
const wav = (seconds: number, fill = 0x40) => {
  const data = Buffer.alloc(seconds * 8000, fill);
  const body = Buffer.concat([Buffer.from("WAVE"), Buffer.from("fmt "), le32(16), le16(1), le16(1), le32(8000), le32(8000), le16(1), le16(8), Buffer.from("data"), le32(data.length), data]);
  return Buffer.concat([Buffer.from("RIFF"), le32(body.length), body]);
};
/** An Ogg page announcing a Theora stream: a video container U-28 has no player for. */
const oggTheora = () => Buffer.concat([Buffer.from("OggS"), Buffer.from([0, 2]), Buffer.alloc(20, 0), Buffer.from([1, 0x80]), Buffer.from("theora"), Buffer.alloc(200, 0x11)]);
/** A Windows executable wearing a .wav suffix. */
const exe = () => Buffer.concat([Buffer.from("MZ"), Buffer.alloc(400, 0x90)]);

// ── fixture: a bot, its task workspace and a room it belongs to ──────────
type FakeTask = { threadId: string; cwd?: string | null; resumeCursors: Record<string, unknown> };
type FakeBot = { id: string; name: string; threadId: string; cwd?: string; resumeCursors: Record<string, unknown>; tasks?: FakeTask[] };
type FakeGroup = { id: string; threadId: string; memberIds: string[]; cwd?: string; pinnedCwd?: string | null; tasks?: Array<{ threadId: string; pinnedCwd?: string | null }> };

/** Same rules as artifactScopes() in server/index.ts, scope for scope: the
 * task and room working folders, then (R3-T4) one `managedOutput` scope per
 * conversation for the managed generated-images root, then (retained
 * artifacts) one thread-less `threadAvailable: false` scope per distinct
 * `artifacts.source_root` row. The two extra kinds are what a copy of only
 * the first two loops missed in fix round 1: the managed root made every
 * thread look like it had two roots, so resolve answered 404 for every
 * workspace audio and video file in the real app. `retainedRoots` stands in
 * for the database rows the real function reads. */
function scopesFor(dataDir: string, bots: FakeBot[], groups: FakeGroup[], retainedRoots: string[] = []): ArtifactScope[] {
  const scopes: ArtifactScope[] = [];
  for (const bot of bots) {
    for (const task of bot.tasks ?? [{ threadId: bot.threadId, cwd: undefined }]) {
      const workspaceRoot = task.cwd === null ? undefined : task.cwd ?? bot.cwd ?? join(dataDir, "workspaces", bot.id);
      if (workspaceRoot) scopes.push({ botId: bot.id, botName: bot.name, threadId: task.threadId, workspaceRoot });
    }
    for (const group of groups.filter(group => group.memberIds.includes(bot.id))) {
      for (const task of group.tasks ?? [{ threadId: group.threadId, pinnedCwd: group.pinnedCwd }]) {
        const pinned = task.pinnedCwd === undefined ? group.cwd : task.pinnedCwd;
        const workspaceRoot = pinned ?? join(dataDir, "workspaces", bot.id);
        if (workspaceRoot) scopes.push({ botId: bot.id, botName: bot.name, threadId: task.threadId, workspaceRoot });
      }
    }
    const imageThreads = new Set<string>([
      ...(bot.tasks ?? [{ threadId: bot.threadId }]).map(task => task.threadId),
      ...groups.filter(group => group.memberIds.includes(bot.id)).flatMap(group => (group.tasks ?? [{ threadId: group.threadId }]).map(task => task.threadId)),
    ]);
    for (const threadId of imageThreads) scopes.push({ botId: bot.id, botName: bot.name, threadId, workspaceRoot: managedImageOutputPath(dataDir, bot.id, threadId), managedOutput: true });
    for (const root of retainedRoots) scopes.push({ botId: bot.id, botName: bot.name, workspaceRoot: root, threadAvailable: false });
  }
  return scopes;
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); __resetMediaAssetsForTests(); });
beforeEach(() => { forgetLocalMedia(); __resetMediaAssetsForTests(); });

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "murage-media-chain-"))); roots.push(base);
  const dataDir = join(base, "data");
  const taskRoot = join(dataDir, "workspaces", "research", "threads", "task-7");
  const roomRoot = join(dataDir, "workspaces", "research", "threads", "room-1");
  mkdirSync(taskRoot, { recursive: true }); mkdirSync(roomRoot, { recursive: true });
  const bot: FakeBot = { id: "research", name: "Research bot", threadId: "task-7", resumeCursors: {}, tasks: [{ threadId: "task-7", cwd: taskRoot, resumeCursors: {} }] };
  const bots = [bot];
  const groups: FakeGroup[] = [{ id: "room", threadId: "room-1", memberIds: ["research"], tasks: [{ threadId: "room-1", pinnedCwd: roomRoot }] }];
  const store = { bots, groups } as never;
  // A task deleted earlier whose registered artifacts Files still keeps: the
  // real function emits its source_root as a thread-less retained scope.
  const retainedRoots = [join(dataDir, "workspaces", "research", "threads", "task-gone")];
  const artifactScopes = () => scopesFor(dataDir, bots, groups, retainedRoots);
  const database = () => { throw new Error("the player chain must not touch the database"); };
  const deps: WorkspaceFilesDeps & MediaAssetsDeps = { dataDir, database, store, artifactScopes };
  const write = (root: string, relative: string, content: Buffer | string) => {
    const path = join(root, ...relative.split("/")); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path;
  };
  /** Exactly what server/index.ts does with a delegated route, minus the socket. */
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<DelegatedResult> => {
    const url = new URL(path, "http://127.0.0.1:1");
    const request: DelegatedRequest = { method, path: url.pathname, url, headers, desktop: true, readBody: async () => body };
    return url.pathname.startsWith("/api/media") ? mediaAssetsRoute(request, deps) : workspaceFilesRoute(request, deps);
  };
  const calls: string[] = [];
  /** The renderer's `api` (src/state/store.tsx): a JSON body, or a thrown Error carrying `status`. */
  const api: MediaApi = async (path, init) => {
    calls.push(path.split("?")[0]!);
    const result = await call(init?.method ?? "GET", path, init?.body ? JSON.parse(String(init.body)) : undefined);
    if (result.status >= 400) throw Object.assign(new Error(String((result.body as { error?: unknown } | undefined)?.error ?? result.status)), { status: result.status });
    return result.body;
  };
  const scope = { botId: "research", threadId: "task-7" };
  return { base, dataDir, taskRoot, roomRoot, retainedRoots, deps, write, call, api, calls, scope };
}

async function drain(result: DelegatedResult): Promise<Buffer> {
  if (result.stream) return Buffer.concat(await result.stream.toArray() as Buffer[]);
  return Buffer.from(result.bytes ?? new Uint8Array(0));
}

describe("the scopes the fixture offers", () => {
  it("are the ones server/index.ts artifactScopes() emits for this bot: task, room, one managed root per thread, retained rows", () => {
    const f = fixture();
    const managed = (threadId: string) => join(f.dataDir, "workspaces", "research", "generated-images", threadId);
    expect(f.deps.artifactScopes()).toEqual([
      { botId: "research", botName: "Research bot", threadId: "task-7", workspaceRoot: f.taskRoot },
      { botId: "research", botName: "Research bot", threadId: "room-1", workspaceRoot: f.roomRoot },
      { botId: "research", botName: "Research bot", threadId: "task-7", workspaceRoot: managed("task-7"), managedOutput: true },
      { botId: "research", botName: "Research bot", threadId: "room-1", workspaceRoot: managed("room-1"), managedOutput: true },
      { botId: "research", botName: "Research bot", workspaceRoot: f.retainedRoots[0], threadAvailable: false },
    ]);
    // Every thread therefore carries two scopes; the chain must read the
    // working folder, and only it, as that conversation's root.
    const perThread = new Map<string, number>();
    for (const scope of f.deps.artifactScopes()) if (scope.threadId) perThread.set(scope.threadId, (perThread.get(scope.threadId) ?? 0) + 1);
    expect([...perThread.values()]).toEqual([2, 2]);
  });
});

describe("a transcript path through discovery, resolve and the byte route", () => {
  it("becomes a player for this conversation's own WAV, and the player's bytes are the file's", async () => {
    const f = fixture(), audio = wav(2);
    const path = f.write(f.taskRoot, "outputs/take-2.wav", audio);
    const result = await resolveLocalMedia({ scope: f.scope, absolutePath: path }, f.api);
    expect(f.calls).toEqual([WORKSPACE_FILES_ROUTES.root, WORKSPACE_FILES_ROUTES.list, MEDIA_ROUTES.resolve]);
    expect(result).toMatchObject({
      state: "ready",
      asset: { source: "workspace", kind: "audio", mime: "audio/wav", name: "take-2.wav", bytes: audio.length, availability: "ready", scope: { botId: "research", threadId: "task-7" },
        capabilities: { preview: true, download: true } },
      url: expect.stringMatching(/^\/api\/media\/bytes\/ma1_[A-Za-z0-9_-]{32}\?cap=mc1\./),
      expiresAt: expect.any(Number),
    });
    if (result.state !== "ready") throw new Error("unreachable");
    // Nothing in the answer names where the file lives.
    expect(JSON.stringify(result)).not.toContain(f.base);
    // A player's first request: metadata from the head of the file.
    const head = await f.call("GET", result.url, undefined, { range: "bytes=0-1023" });
    expect(head.status).toBe(206);
    expect(head.headers).toMatchObject({ "content-type": "audio/wav", "accept-ranges": "bytes", "content-range": `bytes 0-1023/${audio.length}`, "referrer-policy": "no-referrer" });
    expect((await drain(head)).equals(audio.subarray(0, 1024))).toBe(true);
    // A seek: a later range, exact bytes, 206.
    const seek = await f.call("GET", result.url, undefined, { range: `bytes=${audio.length - 500}-` });
    expect(seek.status).toBe(206);
    expect((await drain(seek)).equals(audio.subarray(audio.length - 500))).toBe(true);
    // HEAD for the size, and a range past the end answers 416 rather than bytes.
    const probe = await f.call("HEAD", result.url);
    expect(probe.status).toBe(200);
    expect(probe.headers?.["content-length"]).toBe(String(audio.length));
    probe.stream?.destroy();
    const beyond = await f.call("GET", result.url, undefined, { range: `bytes=${audio.length}-` });
    expect(beyond.status).toBe(416);
    beyond.stream?.destroy();
    // The same path in the same conversation is one shared answer.
    expect(await localMedia({ scope: f.scope, absolutePath: path }, f.api)).toEqual(await localMedia({ scope: f.scope, absolutePath: path }, f.api));
  });

  it("keeps the chip for a path outside the workspace, a link, and a renamed executable", async () => {
    const f = fixture();
    const outside = f.write(f.base, "Music/private.mp3", wav(1));
    expect(await resolveLocalMedia({ scope: f.scope, absolutePath: outside }, f.api)).toEqual({ state: "unavailable" });
    // Outside the root: refused before discovery is even asked.
    expect(f.calls).toEqual([WORKSPACE_FILES_ROUTES.root]);

    f.calls.length = 0;
    symlinkSync(outside, join(f.taskRoot, "linked.wav"));
    expect(await resolveLocalMedia({ scope: f.scope, absolutePath: join(f.taskRoot, "linked.wav") }, f.api)).toEqual({ state: "unavailable" });
    // Discovery names it a link: the resolver is never asked for it.
    expect(f.calls).toEqual([WORKSPACE_FILES_ROUTES.root, WORKSPACE_FILES_ROUTES.list]);

    f.calls.length = 0;
    const pretend = f.write(f.taskRoot, "outputs/song.wav", exe());
    expect(await resolveLocalMedia({ scope: f.scope, absolutePath: pretend }, f.api)).toEqual({ state: "unavailable" });
    // The suffix earned it a question; the bytes answered "not media".
    expect(f.calls).toEqual([WORKSPACE_FILES_ROUTES.root, WORKSPACE_FILES_ROUTES.list, MEDIA_ROUTES.resolve]);

    f.calls.length = 0;
    const private_ = f.write(f.taskRoot, "memory/note.wav", wav(1));
    expect(await resolveLocalMedia({ scope: f.scope, absolutePath: private_ }, f.api)).toEqual({ state: "unavailable" });
  });

  it("never reads the managed generated-images root or a retained root as this conversation's workspace", async () => {
    const f = fixture();
    // A WAV under the R3-T4 managed root: that scope authorizes saved image
    // rows only, so it is not the conversation's working folder and the
    // transcript path stays a chip; discovery is asked and refuses.
    const managedRoot = join(f.dataDir, "workspaces", "research", "generated-images", "task-7");
    const managedTake = f.write(managedRoot, "take.wav", wav(1));
    expect(await resolveLocalMedia({ scope: f.scope, absolutePath: managedTake }, f.api)).toEqual({ state: "unavailable" });
    expect(f.calls).toEqual([WORKSPACE_FILES_ROUTES.root]);
    // A file in a deleted task's retained root: no live conversation owns it.
    f.calls.length = 0;
    const retainedTake = f.write(f.retainedRoots[0]!, "outputs/old.wav", wav(1));
    expect(await resolveLocalMedia({ scope: f.scope, absolutePath: retainedTake }, f.api)).toEqual({ state: "unavailable" });
    expect(f.calls).toEqual([WORKSPACE_FILES_ROUTES.root]);
  });

  it("says why when the harness knows the file but will not play it", async () => {
    const f = fixture();
    const video = f.write(f.taskRoot, "outputs/clip.ogg", oggTheora());
    const result = await resolveLocalMedia({ scope: f.scope, absolutePath: video }, f.api);
    expect(result).toMatchObject({ state: "unplayable", reason: "unsupported", asset: { kind: "video", mime: "video/ogg", availability: "unsupported", name: "clip.ogg" } });
  });

  it("refuses another conversation's workspace, and accepts a room member's own room scope", async () => {
    const f = fixture(), audio = wav(1);
    const path = f.write(f.taskRoot, "outputs/take.wav", audio);
    // The same bot, a different thread: that thread's workspace is elsewhere.
    expect(await resolveLocalMedia({ scope: { botId: "research", threadId: "room-1" }, absolutePath: path }, f.api)).toEqual({ state: "unavailable" });
    // An unknown bot: hidden.
    expect(await resolveLocalMedia({ scope: { botId: "someone-else", threadId: "task-7" }, absolutePath: path }, f.api)).toEqual({ state: "unavailable" });
    // A take the member rendered into the room's pinned workspace, offered
    // under {member bot, room thread} — the scope GroupView passes.
    const roomTake = f.write(f.roomRoot, "outputs/room-take.wav", audio);
    const result = await resolveLocalMedia({ scope: { botId: "research", threadId: "room-1" }, absolutePath: roomTake }, f.api);
    expect(result).toMatchObject({ state: "ready", asset: { kind: "audio", scope: { botId: "research", threadId: "room-1" } } });
    if (result.state !== "ready") throw new Error("unreachable");
    expect((await drain(await f.call("GET", result.url))).equals(audio)).toBe(true);
  });

  it("re-pins a file that changed: the old URL stops, and asking again gives the new take", async () => {
    const f = fixture();
    const path = f.write(f.taskRoot, "outputs/take.wav", wav(1, 0x40));
    const first = await localMedia({ scope: f.scope, absolutePath: path }, f.api);
    if (first.state !== "ready") throw new Error("expected a player");
    // The bot renders a new take over the old one.
    const second = wav(2, 0x41);
    writeFileSync(path, second);
    const later = new Date(Date.now() + 5_000); utimesSync(path, later, later);
    // The player's next range request is refused rather than spliced.
    const stale = await f.call("GET", first.url, undefined, { range: "bytes=0-99" });
    expect(stale.status).toBe(409);
    stale.stream?.destroy();
    // The cached answer would repeat the old URL; the card's refresh drops it
    // and asks again, and discovery now issues the new revision.
    expect(await localMedia({ scope: f.scope, absolutePath: path }, f.api)).toBe(first);
    forgetLocalMedia({ scope: f.scope, absolutePath: path });
    const refreshed = await localMedia({ scope: f.scope, absolutePath: path }, f.api);
    expect(refreshed).toMatchObject({ state: "ready", asset: { id: first.asset.id, bytes: second.length } });
    if (refreshed.state !== "ready") throw new Error("unreachable");
    expect(refreshed.asset.revision).not.toBe(first.asset.revision);
    expect(refreshed.url).not.toBe(first.url);
    expect((await drain(await f.call("GET", refreshed.url))).equals(second)).toBe(true);
  });
});
