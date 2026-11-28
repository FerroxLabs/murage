// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A stored <uuid>.tar.gz archive travels the whole attachment path on a booted server: the upload answers a masked name, Settings > Storage
// lists it, Remove drops it, and the startup backfill (indexAttachmentNamesChunk over a real messages table) names it for conversation deletion.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { fixturePlatformEnv, stopFixtureServer } from "./testing/platform-fixtures.ts";
import { freePortBlock } from "./testing/ports.ts";
import { indexAttachmentNamesChunk } from "./transcript-backfill.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
let base: string, home: string, child: ChildProcess, stderr = "";
let desktop: Record<string, string>;

beforeAll(async () => {
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  home = mkdtempSync(join(tmpdir(), "murage-archive-routes-"));
  mkdirSync(join(home, ".murage"), { recursive: true });
  writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {} }));
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    windowsHide: true,
    cwd: join(SERVER_DIR, ".."),
    env: { ...fixturePlatformEnv(), NODE_ENV: "test", ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stderr!.on("data", c => (stderr += c));
  child.stdout!.on("data", c => (stderr += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise(r => setTimeout(r, 150));
  }
  const proof = (await fetch(`${base}/api/desktop-secret`).then(r => r.json())) as { secret: string };
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 40_000);
afterAll(async () => { await stopFixtureServer(child); await removeTempDir(home); });

const upload = (name: string, mime: string) =>
  fetch(`${base}/api/files?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...desktop, "content-type": mime }, body: Buffer.from("opaque archive fixture") });
const listed = async () => {
  const response = await fetch(`${base}/api/storage/attachments?limit=100`, { headers: desktop });
  const body = await response.json() as { state?: string; items?: { name: string }[] };
  if (!body.items) throw new Error(`list answered ${response.status} ${JSON.stringify(body)}`);
  return body.items.map(item => item.name);
};

it.each(["bundle.tar.gz", "bundle.tar.zst"])("Storage lists an uploaded %s and Remove drops it", async (name) => {
  const response = await upload(name, "application/gzip");
  expect(response.status).toBe(201);
  const stored = basename(((await response.json()) as { path: string }).path);
  expect(await listed()).toContain(stored);
  const removed = await fetch(`${base}/api/storage/attachments/remove`, {
    method: "POST", headers: { ...desktop, "content-type": "application/json" }, body: JSON.stringify({ names: [stored] }),
  });
  expect(removed.status).toBe(200);
  expect(await listed()).not.toContain(stored);
});

// Seeded on disk, not uploaded: the file is what any earlier run (or a drag into the folder) left behind, so these rows reach Storage's
// list and Remove whatever the upload path accepts.
it.each(["tar.gz", "tar.bz2", "tar.xz", "tar.zst"])("Storage lists a stored <uuid>.%s archive and Remove drops it", async (suffix) => {
  const dir = join(home, ".murage", "attachments");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stored = `5a1c9d3e-2222-4333-8444-${String(["tar.gz", "tar.bz2", "tar.xz", "tar.zst"].indexOf(suffix) + 1).padStart(12, "0")}.${suffix}`;
  writeFileSync(join(dir, stored), "opaque archive fixture");
  expect(await listed()).toContain(stored);
  const removed = await fetch(`${base}/api/storage/attachments/remove`, {
    method: "POST", headers: { ...desktop, "content-type": "application/json" }, body: JSON.stringify({ names: [stored] }),
  });
  expect(removed.status).toBe(200);
  expect(existsSync(join(dir, stored))).toBe(false);
  expect(await listed()).not.toContain(stored);
});

// Declared pre-fix sha for this row: 415a3b2f25 (RED here at the credential assertion). dev/1024 has no archive upload at all, so it answers 400 first.
it("the upload response masks a credential written with compatibility characters, on disk and in the answer", async () => {
  const wide = (text: string) => Array.from(text, ch => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join("");
  const response = await upload(`${wide("sk-proj-" + "a".repeat(60))}.zip`, "application/zip");
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("a".repeat(20));
  expect(text).not.toContain("sk-proj");
  const saved = JSON.parse(text) as { path: string; name: string };
  expect(saved.name).toContain("«redacted");
  expect(existsSync(saved.path)).toBe(true);
  expect(readFileSync(saved.path, "utf8")).toBe("opaque archive fixture");
});

it.each(["tar.gz", "tar.bz2", "tar.xz", "tar.zst"])("the startup backfill indexes a message that names a stored .%s archive", (suffix) => {
  const db = new DatabaseSync(":memory:");
  initializeMessageTables(db);
  const name = `0b7c1f2e-1111-4222-8333-444455556666.${suffix}`;
  db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES (?, ?, 1, 'user', 'text', 'files', ?)")
    .run("t1", "m1", JSON.stringify({ id: "m1", attachments: [{ kind: "file", path: `/store/${name}` }] }));
  while (indexAttachmentNamesChunk(db, 100, 60_000)) { /* to done */ }
  expect(db.prepare("SELECT name, thread_id FROM attachment_name").all().map(row => ({ ...row }))).toEqual([{ name, thread_id: "t1" }]);
  db.close();
});
