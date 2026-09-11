// F5-T1: the media routes through the real harness (server/index.ts routing,
// desktop gate, sendDelegated streaming) against an isolated fake-engine app.
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { mediaWorkspaceRevision } from "./media-assets.ts";
import { COMPANION_HEADER } from "./sse-visibility.ts";
import { MEDIA_CAPABILITY_QUERY_PARAM, MEDIA_ROUTES, redactMediaCapability, type MediaResolveResponse } from "../shared/media-assets.ts";

const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const png = (width: number, height: number, tail: number) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0]), u32(0),
  Buffer.alloc(tail, 0x5c), Buffer.from("IEND"),
]);

let fixture: VerificationServer, desktop: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = desktop) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
beforeAll(async () => {
  fixture = await launchVerificationServer();
  const proof = await api("GET", "/api/desktop-secret", undefined, {});
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

it("resolves saved and workspace media for the desktop only and streams exact ranges without the desktop header", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Media fixture" })).body.bot as { id: string; threadId: string };
  const root = join(fixture.info.dataDir, "workspaces", bot.id); mkdirSync(root, { recursive: true });
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
