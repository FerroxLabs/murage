// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W-D7 (0.1.60 Windows customer re-test 2): a backup that stopped was only
// visible in Settings > Backups. The desktop now reports the stage and code
// after the restart that follows it; the Inbox says what failed and what to
// do until the review is cleared, and one notification goes out.
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
let base: string, home: string, child: ChildProcess, stderr = "";
let desktopHeaders: Record<string, string> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const request = async (method: string, path: string, body?: unknown, headers = desktopHeaders): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

describe.skipIf(process.platform === "win32")("a backup that stopped is announced in the Inbox (W-D7)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 18_999, 200);
    base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), "murage-backup-failure-notice-"));
    expect(home.startsWith(tmpdir())).toBe(true);
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: {} }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await sleep(150);
    }
    const proof = await request("GET", "/api/desktop-secret", undefined, {});
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);
  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("only the desktop can report, and only the finite stage and code", async () => {
    expect((await request("POST", "/api/backup-failure-notice", { action: "report", stage: "capture", code: "BACKUP_FILE_IN_USE" }, {})).status).toBe(404);
    expect((await request("POST", "/api/backup-failure-notice", { action: "report", stage: "capture", code: "BACKUP_FILE_IN_USE", path: "C:\\Users\\Sam Lee" })).status).toBe(400);
    expect((await request("GET", "/api/inbox?view=decisions")).body.backupFailed).toBeUndefined();
  });

  it("the Inbox says what failed and what to do until it is cleared", async () => {
    const reported = await request("POST", "/api/backup-failure-notice", { action: "report", stage: "capture", code: "BACKUP_FILE_IN_USE", notify: true });
    expect(reported.status).toBe(200);
    expect(reported.body.reported).toBe(true);
    // The desktop shows the notification itself, with these words.
    expect(reported.body.sentence).toMatch(/Another program was holding a file/);
    for (const view of ["decisions", "to-read", "all"]) {
      const inbox = (await request("GET", `/api/inbox?view=${view}`)).body;
      expect(inbox.backupFailed.sentence).toMatch(/while copying your workspace/);
      expect(inbox.backupFailed.sentence).toMatch(/Another program was holding a file/);
      expect(inbox.backupFailed.sentence).toMatch(/Open Settings, then Backups/);
      expect(inbox.backupFailed.sentence).not.toMatch(/recovery key|BACKUP_|\u2014/);
    }
    // A code outside the closed set is never passed through.
    await request("POST", "/api/backup-failure-notice", { action: "report", stage: "capture", code: "SOMETHING_PRIVATE" });
    expect((await request("GET", "/api/inbox?view=decisions")).body.backupFailed.sentence).not.toContain("SOMETHING_PRIVATE");
    expect((await request("POST", "/api/backup-failure-notice", { action: "clear" })).body).toEqual({ cleared: true });
    expect((await request("GET", "/api/inbox?view=decisions")).body.backupFailed).toBeUndefined();
  });
});
