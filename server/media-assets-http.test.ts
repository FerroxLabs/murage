import { structuralPng as png } from "./testing/workspace-image-fixtures.ts";
// F5-T1: the media routes through the real harness (server/index.ts routing,
// desktop gate, sendDelegated streaming) against an isolated fake-engine app.
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { mediaWorkspaceRevision } from "./media-assets.ts";
import { COMPANION_HEADER } from "./sse-visibility.ts";
import { MEDIA_CAPABILITY_QUERY_PARAM, MEDIA_ROUTES, redactMediaCapability, type MediaResolveResponse } from "../shared/media-assets.ts";



let fixture: VerificationServer, desktop: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = desktop) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    const realNow = Date.now;
    Date.now = () => realNow() + (existsSync(join(process.env.MURAGE_DATA_DIR, 'advance-media-clock')) ? 700000 : 0);
  ` });
  const proof = await api("GET", "/api/desktop-secret", undefined, {});
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

it("resolves saved and workspace media for the desktop only and streams exact ranges without the desktop header", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Media fixture" })).body.bot as { id: string; threadId: string };
  // A bot's default file workspace is its per-conversation managed root (workspace.ts taskWorkspacePath).
  const root = join(fixture.info.dataDir, "workspaces", bot.id, "threads", bot.threadId); mkdirSync(root, { recursive: true });
  const image = png(320, 200, 700_000);
  writeFileSync(join(root, "photo.png"), image);
  const registered = await api("POST", "/api/artifacts/register", { botId: bot.id, threadId: bot.threadId, relativePath: "photo.png", name: "Photo" });
  expect(registered.status).toBe(201);
  const artifactId = registered.body.artifact.id as string;

  // Resolve: hidden without desktop proof or through the companion door.
  expect((await api("POST", MEDIA_ROUTES.resolve, { ref: { source: "artifact", artifactId } }, {})).status).toBe(404);
  expect((await api("POST", MEDIA_ROUTES.resolve, { ref: { source: "artifact", artifactId } }, { ...desktop, [COMPANION_HEADER]: "1" })).status).toBe(404);
  expect((await api("GET", "/api/media", undefined, {})).status).toBe(404);
  const resolved = await api("POST", MEDIA_ROUTES.resolve, { ref: { source: "artifact", artifactId } });
  expect(resolved.status).toBe(200);
  const { asset, url } = resolved.body as MediaResolveResponse & { url: string };
  expect(asset).toMatchObject({ source: "artifact", kind: "image", mime: "image/png", width: 320, height: 200, bytes: image.length, availability: "ready", scope: { botId: bot.id, threadId: bot.threadId } });
  expect(url.startsWith(`${MEDIA_ROUTES.bytes}/${asset.id}?${MEDIA_CAPABILITY_QUERY_PARAM}=`)).toBe(true);

  // Bytes: no desktop header, no JSON content type, real HTTP streaming.
  const full = await fetch(`${fixture.info.url}${url}`);
  expect(full.status).toBe(200);
  expect(full.headers.get("content-type")).toBe("image/png");
  expect(full.headers.get("referrer-policy")).toBe("no-referrer");
  expect(full.headers.get("cache-control")).toBe("private, no-store");
  expect(full.headers.get("x-content-type-options")).toBe("nosniff");
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  expect(full.headers.get("content-length")).toBe(String(image.length));
  expect(Buffer.from(await full.arrayBuffer()).equals(image)).toBe(true);

  const head = await fetch(`${fixture.info.url}${url}`, { method: "HEAD" });
  expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe(String(image.length)); expect((await head.arrayBuffer()).byteLength).toBe(0);

  const range = await fetch(`${fixture.info.url}${url}`, { headers: { range: "bytes=300000-300099" } });
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe(`bytes 300000-300099/${image.length}`);
  expect(range.headers.get("content-length")).toBe("100");
  expect(Buffer.from(await range.arrayBuffer()).equals(image.subarray(300000, 300100))).toBe(true);

  const multi = await fetch(`${fixture.info.url}${url}`, { headers: { range: "bytes=0-1,5-6" } });
  expect(multi.status).toBe(416); expect(multi.headers.get("content-range")).toBe(`bytes */${image.length}`); await multi.text();
  const beyond = await fetch(`${fixture.info.url}${url}`, { headers: { range: `bytes=${image.length}-` } });
  expect(beyond.status).toBe(416); await beyond.text();

  // A player seeks: range requests are abandoned before and after the first
  // bytes arrive, more of them than there are stream slots. None may keep a
  // slot, so the next request is served in full rather than answered 503.
  for (let index = 0; index < 24; index++) {
    const controller = new AbortController();
    const attempt = fetch(`${fixture.info.url}${url}`, { signal: controller.signal, headers: { range: `bytes=${index * 4096}-` } }).then(response => response.arrayBuffer()).catch(() => undefined);
    setImmediate(() => controller.abort());
    await attempt;
  }
  // An abandoned request gives its slot back when its socket closes, which
  // is the client's abort reaching the server: on macOS and Linux most of
  // the burst never reaches it at all and the rest close before the next
  // request lands; on Windows every one reaches the server and the closes
  // of the loopback connections land a few tens of milliseconds after the
  // burst (WIN1 measured ~80 ms for the 24). A slot that is never given
  // back keeps answering 503 past any such wait, which is what this bounds.
  await expect.poll(async () => {
    const response = await fetch(`${fixture.info.url}${url}`, { headers: { range: "bytes=0-" } });
    await response.arrayBuffer();
    return response.status;
  }, { timeout: 5_000, interval: 25 }).toBe(206);
  for (let index = 0; index < 10; index++) {
    const seek = await fetch(`${fixture.info.url}${url}`, { headers: { range: `bytes=${index * 4096}-` } });
    expect(seek.status).toBe(206);
    const reader = seek.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
  }
  const afterSeeks = await fetch(`${fixture.info.url}${url}`);
  expect(afterSeeks.status).toBe(200);
  expect(Buffer.from(await afterSeeks.arrayBuffer()).equals(image)).toBe(true);
  // A method a capability holder cannot use is refused; without the capability the route stays hidden.
  const post = await fetch(`${fixture.info.url}${url}`, { method: "POST" });
  expect(post.status).toBe(405); await post.text();
  const blindPost = await fetch(`${fixture.info.url}${MEDIA_ROUTES.bytes}/${asset.id}`, { method: "POST" });
  expect(blindPost.status).toBe(404); await blindPost.text();

  // The capability alone is not enough through the companion door, and a bad one is hidden.
  const viaDoor = await fetch(`${fixture.info.url}${url}`, { headers: { [COMPANION_HEADER]: "1" } });
  expect(viaDoor.status).toBe(404); await viaDoor.text();
  const forged = await fetch(`${fixture.info.url}${MEDIA_ROUTES.bytes}/${asset.id}?cap=mc1.${"A".repeat(20)}.${"B".repeat(43)}`);
  expect(forged.status).toBe(404); await forged.text();
  const bare = await fetch(`${fixture.info.url}${MEDIA_ROUTES.bytes}/${asset.id}`, { headers: desktop });
  expect(bare.status).toBe(404); await bare.text();

  // Workspace source, pinned to the revision discovery would issue.
  const canonical = realpathSync.native(root), revision = mediaWorkspaceRevision(canonical, "photo.png", lstatSync(join(root, "photo.png")));
  const workspace = await api("POST", MEDIA_ROUTES.resolve, { ref: { source: "workspace", scope: { botId: bot.id, threadId: bot.threadId }, relativePath: "photo.png", revision } });
  expect(workspace.status).toBe(200);
  expect(workspace.body.asset).toMatchObject({ source: "workspace", kind: "image", mime: "image/png", availability: "ready", revision });
  expect(JSON.stringify(workspace.body)).not.toContain(root);
  const tail = await fetch(`${fixture.info.url}${workspace.body.url}`, { headers: { range: "bytes=-16" } });
  expect(tail.status).toBe(206); expect(Buffer.from(await tail.arrayBuffer()).equals(image.subarray(image.length - 16))).toBe(true);
  // Another conversation of the same app cannot reach it.
  const stranger = (await api("POST", "/api/bots", { name: "Other fixture" })).body.bot as { id: string; threadId: string };
  expect((await api("POST", MEDIA_ROUTES.resolve, { ref: { source: "workspace", scope: { botId: stranger.id, threadId: bot.threadId }, relativePath: "photo.png", revision } })).status).toBe(404);

  // No capability value reaches the server log.
  const token = new URL(`http://x${url}`).searchParams.get(MEDIA_CAPABILITY_QUERY_PARAM)!;
  const log = readFileSync(fixture.info.logPath, "utf8");
  expect(log).not.toContain(token);
  expect(redactMediaCapability(url)).not.toContain(token);
}, 30000);

it("T2/R32-RESTART and H7-log-sinks: actual restart revokes old URLs and logs hide capabilities", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Restart fixture" })).body.bot;
  const scope = { botId: bot.id, threadId: bot.threadId };
  const root = join(fixture.info.dataDir, "workspaces", bot.id, "threads", bot.threadId);
  mkdirSync(root, { recursive: true });
  const path = join(root, "restart.png"); writeFileSync(path, png(1, 1));
  const revision = mediaWorkspaceRevision(realpathSync.native(root), "restart.png", lstatSync(path));
  const ref = { source: "workspace", scope, relativePath: "restart.png", revision };
  const original = (await api("POST", MEDIA_ROUTES.resolve, { ref })).body as MediaResolveResponse & { url: string };
  expect(original.asset.frameCount).toBe(1);
  const tokens = [new URL(original.url, fixture.info.url).searchParams.get("cap")!];
  const success = await fetch(new URL(original.url, fixture.info.url)); expect(success.status).toBe(200); await success.arrayBuffer();
  writeFileSync(path, png(2, 1));
  const changed = await fetch(new URL(original.url, fixture.info.url)); expect(changed.status).toBe(409); await changed.text();
  const hidden = await fetch(new URL(original.url, fixture.info.url), { headers: { [COMPANION_HEADER]: "1" } }); expect(hidden.status).toBe(404); await hidden.text();
  writeFileSync(join(fixture.info.dataDir, "advance-media-clock"), "1");
  const expired = await fetch(new URL(original.url, fixture.info.url)); expect(expired.status).toBe(403); await expired.text();
  (await import("node:fs")).unlinkSync(join(fixture.info.dataDir, "advance-media-clock"));
  // Exercise the client transport in Vitest without adding browser modules to the server build graph.
  const clientSaveModule = "../src/lib/local-image-save.ts";
  const { saveLocalImage, localImageSaveBusy } = await import(clientSaveModule);
  const heldRevision = mediaWorkspaceRevision(realpathSync.native(root), "restart.png", lstatSync(path));
  const held = (await api("POST", MEDIA_ROUTES.resolve, { ref: { ...ref, revision: heldRevision } })).body as MediaResolveResponse & { url: string };
  let resume!: () => void; const waiting = new Promise<void>(resolve => { resume = resolve; });
  let reads = 0, renewals = 0, handed = 0;
  const saving = saveLocalImage({ shown: { state: 'ready', ...held, canonicalKey: 'restart', generation: 1, relativePath: 'restart.png' }, live: () => true,
    fetcher: async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => { if (++reads === 1) await waiting; return fetch(new URL(String(url), fixture.info.url), init); },
    renew: async () => { renewals++; const result = (await api("POST", MEDIA_ROUTES.resolve, { ref: { ...ref, revision: heldRevision } })).body; return { state: 'ready', ...result, canonicalKey: 'restart', generation: 2, relativePath: 'restart.png' }; },
    native: async () => false, handoff: async (blob: Blob) => { handed++; expect(Buffer.from(await blob.arrayBuffer())).toEqual(png(2, 1)); }, report: (error: unknown) => { throw error; } });
  expect(localImageSaveBusy()).toBe(true);
  await fixture.restart();
  const proof = await api("GET", "/api/desktop-secret", undefined, {});
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  resume(); expect(await saving.result).toEqual({ state: 'saved' }); expect(reads).toBe(2); expect(renewals).toBe(1); expect(handed).toBe(1);
  const revoked = await fetch(new URL(original.url, fixture.info.url)); expect(revoked.status).toBe(404); await revoked.text();
  const nextRevision = mediaWorkspaceRevision(realpathSync.native(root), "restart.png", lstatSync(path));
  const fresh = (await api("POST", MEDIA_ROUTES.resolve, { ref: { ...ref, revision: nextRevision } })).body as MediaResolveResponse & { url: string };
  expect(fresh.asset.availability).toBe("ready"); expect(fresh.asset.id).not.toBe(original.asset.id);
  tokens.push(new URL(fresh.url, fixture.info.url).searchParams.get("cap")!);
  const freshBytes = await fetch(new URL(fresh.url, fixture.info.url)); expect(freshBytes.status).toBe(200);
  expect(Buffer.from(await freshBytes.arrayBuffer())).toEqual(png(2, 1));
  const log = readFileSync(fixture.info.logPath, "utf8");
  for (const token of tokens) expect(log).not.toContain(token);
}, 45000);

it('F12 BF-22 both media writes require proof and hide from companions and unproven callers', async () => {
  const bot = (await api('POST', '/api/bots', { name: 'Authorization fixture' })).body.bot;
  const scope = { botId: bot.id, threadId: bot.threadId }, root = join(fixture.info.dataDir, 'workspaces', bot.id, 'threads', bot.threadId);
  mkdirSync(root, { recursive: true }); const path = join(root, 'matrix.png'); writeFileSync(path, png(1, 1));
  const revision = mediaWorkspaceRevision(realpathSync.native(root), 'matrix.png', lstatSync(path));
  for (const [route, body] of [
    [MEDIA_ROUTES.resolve, { ref: { source: 'workspace', scope, relativePath: 'matrix.png', revision } }],
    [MEDIA_ROUTES.reference, { ...scope, source: { kind: 'workspace', relativePath: 'matrix.png', revision } }],
  ] as const) {
    for (const headers of [{}, { 'x-murage-surface': 'desktop' }, { ...desktop, [COMPANION_HEADER]: '1' }] as Record<string, string>[]) {
      const response = await api('POST', route, body, headers);
      expect(response.status).toBe(404); expect(response.body).toEqual({ error: 'no such route' });
    }
    expect((await api('POST', route, body)).status).toBe(200);
  }
});
