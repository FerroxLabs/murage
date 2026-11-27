// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../../scripts/control-murage.ts";
import { resolveLocalMedia } from "./media-resolve.ts";

it("marks an earlier image after an engine session changes and serves chat video ranges through the player route", async () => {
  const session = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = path.join(process.env.MURAGE_DATA_DIR, "config.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.instances.replay = { ...config.instances.verification, displayName: "Replay fixture" };
    fs.writeFileSync(file, JSON.stringify(config));
  ` });
  const env = { MURAGE_URL: session.info.url };
  try {
    expect(await runControlMurage(["doctor"], { env })).toMatchObject({ ok: true });
    const { bot } = await runControlMurage(["new-bot", "--name", "Media fixture"], { env }) as { bot: { id: string; activeTaskId: string } };
    const { secret } = await (await fetch(`${session.info.url}/api/desktop-secret`)).json() as { secret: string };
    const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const api = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${session.info.url}${path}`, { ...init, headers: { ...headers, "content-type": "application/json", ...init?.headers } });
      expect(response.status, path.split("?")[0]).toBe(200);
      return response.json();
    };
    // Exercise image replay independently of optional memory preparation.
    await api("/api/memory/action", { method: "POST", body: JSON.stringify({ action: "configure", mode: "off" }) });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
    const upload = await fetch(`${session.info.url}/api/attachments?threadId=${bot.activeTaskId}`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: png });
    expect(upload.status).toBe(201);
    const saved = await upload.json() as { path: string };
    const imageTag = `<attached-image path="${saved.path}" />`;
    const note = "[These images were attached to an earlier message. They do not show the current screen.]";
    await runControlMurage(["send", "--bot", bot.id, "--text", `Earlier picture\n${imageTag}`], { env });
    expect(await runControlMurage(["wait", "--bot", bot.id, "--timeout", "30"], { env })).toMatchObject({ status: "settled" });
    expect(JSON.stringify(JSON.parse(readFileSync(session.fixtureDumpPath, "utf8")).prompt)).not.toContain(note);
    await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "replay", model: "sonnet" } }) });
    await runControlMurage(["send", "--bot", bot.id, "--text", "What did the earlier picture show?"], { env });
    expect(await runControlMurage(["wait", "--bot", bot.id, "--timeout", "30"], { env })).toMatchObject({ status: "settled" });
    const dump = JSON.parse(readFileSync(session.fixtureDumpPath, "utf8"));
    const messages = await runControlMurage(["messages", "--bot", bot.id], { env });
    expect(JSON.stringify(messages)).not.toContain(note);

    // Chat's LocalMedia uses the renderer resolver, then the capability URL.
    const scope = { botId: bot.id, threadId: bot.activeTaskId };
    const query = new URLSearchParams(scope);
    const root = await api(`/api/workspace-files/root?${query}`) as { state: string; displayPath: string };
    expect(root.state).toBe("ready");
    const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isommp41"), Buffer.from([0, 0, 0, 72]), Buffer.from("mdat"), Buffer.alloc(64, 0x44)]);
    const videoPath = join(root.displayPath, "clip.mp4");
    writeFileSync(videoPath, video);
    const resolved = await resolveLocalMedia({ scope, absolutePath: videoPath }, api);
    expect(resolved.state).toBe("ready");
    if (resolved.state !== "ready") throw new Error("expected ready video");
    expect(resolved.asset.kind).toBe("video");
    const target = `${session.info.url}${resolved.url}`;
    const whole = await fetch(target);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(video);
    for (const [range, start, end] of [["bytes=4-11", 4, 12], ["bytes=-8", video.length - 8, video.length], ["bytes=24-", 24, video.length]] as const) {
      const part = await fetch(target, { headers: { range } });
      expect(part.status).toBe(206);
      expect(part.headers.get("content-range")).toBe(`bytes ${start}-${end - 1}/${video.length}`);
      expect(Buffer.from(await part.arrayBuffer())).toEqual(video.subarray(start, end));
    }
    const bad = await fetch(target, { headers: { range: "bytes=9999-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe(`bytes */${video.length}`);
    await bad.text();
    const noCapability = new URL(target); noCapability.search = "";
    const denied = await fetch(noCapability, { headers: { range: "bytes=4-11", "x-test-bare-loopback": "1" } });
    expect(denied.status).toBe(404);
    await denied.text();
    const outside = await fetch(`${session.info.url}/api/media/resolve`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ref: { source: "workspace", scope, relativePath: "../clip.mp4", revision: resolved.asset.revision } }) });
    expect(outside.status).toBe(400);
    await outside.text();
    expect(JSON.stringify(dump.prompt)).toContain("Earlier picture");
    expect(JSON.stringify(dump.prompt)).toContain(note);
  } finally { await session.close(); }
}, 120_000);
