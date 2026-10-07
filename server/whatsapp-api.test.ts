// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The WhatsApp routes and settings on a real server process (design 7.4): desktop-proof only, settings round trip and
// validation, the link target owned by the link route, and a restart that finds nothing linked. The socket is never
// started here: no route below reaches the bridge, and no real WhatsApp is contacted.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const secret = "0123456789abcdef".repeat(4);
const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
const ROUTES: Array<[string, string]> = [["GET", "status"], ["GET", "groups"], ["POST", "link"], ["POST", "approve"], ["POST", "dismiss"], ["POST", "resume"], ["POST", "revoke"], ["POST", "unlink"]];

it("serves the WhatsApp routes to the desktop only, validates settings and starts nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-whatsapp-api-")), data = join(home, "data"), staticDir = join(home, "static");
  mkdirSync(data); mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>WhatsApp fixture</title>"); writeFileSync(join(staticDir, "assets/test.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit" }));
  const port = await freePortBlock([0, 1]); let child: ChildProcess | undefined; let stderr = "";
  const request = async (method: string, path: string, body?: unknown, owner = true): Promise<{ status: number; body: any }> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(owner ? desktop : {}), "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() };
  };
  const boot = async () => {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data, MURAGE_STATIC_DIR: staticDir, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_DEV_DESKTOP_SECRET: secret, PATH: process.env.PATH };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.on("data", chunk => { stderr += chunk; });
    await expect.poll(async () => { if (child!.exitCode !== null) throw new Error("Fixture exited: " + stderr); try { return (await request("GET", "/api/health")).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  };
  try {
    await boot();
    // Not the desktop: every route is refused the way the other channels are.
    for (const [method, path] of ROUTES) expect((await request(method, "/api/whatsapp/" + path, method === "POST" ? {} : undefined, false)).status, path).toBe(404);

    const status = await request("GET", "/api/whatsapp/status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ state: "idle", linked: false, enabled: false, number: null, busy: false,
      settings: { mode: "self-chat", allowFrom: [], readReceipts: false, quoteReplies: "groups", groups: { policy: "disabled", allow: [], senders: "members" } } });
    expect((await request("GET", "/api/whatsapp/groups")).body).toEqual({ groups: [] });

    // Nothing is linked: the contact routes say so and change nothing.
    for (const path of ["approve", "dismiss", "resume"]) expect((await request("POST", "/api/whatsapp/" + path, { code: "ABC123" })).status, path).toBe(409);
    // A fresh bot is not a Chief, so linking is refused before any bridge exists.
    expect((await request("POST", "/api/whatsapp/link", { method: "qr" })).status).toBe(409);

    // Settings round trip through the generic config route, read live by the status.
    const settings = { mode: "contacts", allowFrom: ["+15551230000"], readReceipts: true, quoteReplies: "all",
      groups: { policy: "allowlist", allow: [{ jid: "120363000000000000@g.us", name: "Family", activation: "mention" }], senders: "allowlist" } };
    expect((await request("PATCH", "/api/config", { whatsapp: settings })).status).toBe(200);
    expect((await request("GET", "/api/whatsapp/status")).body.settings).toEqual(settings);
    expect(JSON.parse(readFileSync(join(data, "config.json"), "utf8")).whatsapp).toMatchObject(settings);

    // Validation and ownership of the target.
    expect((await request("PATCH", "/api/config", { whatsapp: { groups: { policy: "allowlist", allow: [{ jid: "x@g.us", activation: "sometimes" }], senders: "members" } } })).status).toBe(400);
    expect((await request("PATCH", "/api/config", { whatsapp: { mode: "everyone" } })).status).toBe(400);
    expect((await request("PATCH", "/api/config", { whatsapp: { surprise: true } })).status).toBe(400);
    expect((await request("PATCH", "/api/config", { whatsapp: { targetBotId: "other" } })).status).toBe(409);
    expect((await request("GET", "/api/whatsapp/status")).body.settings.mode).toBe("contacts");
    // Not the desktop: the generic config route cannot be used to change it.
    expect((await request("PATCH", "/api/config", { whatsapp: { mode: "self-chat" } }, false)).status).toBe(404);

    expect((await request("POST", "/api/whatsapp/revoke", {})).status).toBe(200);
    expect((await request("POST", "/api/whatsapp/unlink", {})).status).toBe(200);

    // Nothing was written for a session: no bridge directory and no key file were created.
    expect(readdirSync(data)).not.toContain("whatsapp");
    expect(stderr).not.toMatch(/[0-9a-f]{64}/);
  } finally { if (child) await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); }

}, 60000);
