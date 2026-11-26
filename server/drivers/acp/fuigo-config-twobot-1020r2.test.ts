// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: Fuigo local-model entries in the owner's Fuigo config.toml (fuigo.ts ensureFuigoLocalModel / removeFuigoLocalHost
// through writeFuigoConfig). Consumer: every Fuigo engine that starts and reads that config.toml (each bot's, the owner's).
// FUIGO2BOT r2 (review of 76892ffe08, fuigo.ts:590/606): the entry was written IN PLACE, so another bot's engine reading
// config.toml while a local-model pick rewrote it could read half the old file and half the new. A real second process
// reads the file across the write here. Windows forbids replacing a file another process holds open, so there the held
// case falls back to the in-place write (pinned below with the Windows rule), never a failed turn.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureLocalServerStore, writeLocalServers } from "../../local-servers.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { heldByOtherProcess, installWindowsReplaceRule, replaceAttempts } from "../../testing/windows-replace-rule.mjs";
import { localHost } from "../local-inject.ts";
import { ensureFuigoLocalModel, fuigoLocalSlug } from "./fuigo.ts";

const SERVER = { id: "srv_twobot0123ab", name: "BoxA", kind: "llamacpp" as const, apiBase: "http://127.0.0.1:18081/v1", apiKey: "local-fixture-key", createdAt: 1, updatedAt: 1 };
const MODEL = "Qwen3";
const temps: string[] = [];
const children: ChildProcess[] = [];
let uninstall: (() => void) | null = null;
let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "murage-fuigocfg2bot-"));
  temps.push(root);
  configureLocalServerStore(join(root, "data"));
  writeLocalServers([SERVER]);
});
afterEach(async () => {
  uninstall?.(); uninstall = null;
  configureLocalServerStore(null);
  for (const child of children.splice(0)) { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } }
  for (const dir of temps.splice(0)) removeTempDirSync(dir);
});

/** The owner's config: Murage's entry for this pick with an older base_url FIRST, then the owner's own settings, so a
 *  rewrite moves bytes at the start of the file. */
function seed(home: string): { path: string; old: string; slug: string } {
  const slug = fuigoLocalSlug(localHost(SERVER.id)!, MODEL);
  const owner = Array.from({ length: 2000 }, (_, i) => `# owner setting line ${String(i).padStart(4, "0")} keeps this file well past one read`).join("\n");
  const old = `[model."${slug}"]\nmodel = "${MODEL}"\nbase_url = "http://127.0.0.1:19999/v1"\n\n${owner}\n`;
  mkdirSync(home, { recursive: true });
  const path = join(home, "config.toml");
  writeFileSync(path, old, { mode: 0o644 });
  return { path, old, slug };
}

/** Another bot's engine starting: a real process that opens config.toml, reads its first `head` bytes, says so, and
 *  reads the rest only when told; resolves with everything it read through that one open. */
function reader(path: string, head: number): { ready: Promise<void>; finish: () => Promise<string> } {
  const out = join(root, "reader.out");
  const child = spawn(process.execPath, ["-e", `const fs = require("node:fs"); const fd = fs.openSync(process.argv[1], "r"); const parts = []; const b = Buffer.alloc(Number(process.argv[2])); let n = 0; while (n < b.length) { const r = fs.readSync(fd, b, n, b.length - n, null); if (r === 0) break; n += r; } parts.push(b.subarray(0, n)); process.stdout.write("ready\\n"); process.stdin.once("data", () => { const c = Buffer.alloc(65536); for (;;) { const r = fs.readSync(fd, c, 0, c.length, null); if (r === 0) break; parts.push(Buffer.from(c.subarray(0, r))); } fs.writeFileSync(process.argv[3], Buffer.concat(parts)); process.exit(0); });`, path, String(head), out], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  children.push(child);
  return {
    ready: once(child.stdout!, "data").then(([chunk]) => { expect(String(chunk)).toBe("ready\n"); }),
    finish: async () => { child.stdin!.write("go\n"); const [code] = await once(child, "exit"); expect(code).toBe(0); return readFileSync(out, "utf8"); },
  };
}

describe("FUIGO2BOT r2: config.toml shared by every Fuigo bot's engine", () => {
  // Windows refuses the replace while the reader holds the file; that case is the in-place fallback below.
  it.skipIf(process.platform === "win32")("an engine reading config.toml while another bot's local pick rewrites it reads one whole file, old or new", async () => {
    const home = join(root, "fuigo-home");
    const { path, old, slug } = seed(home);
    const head = 4096;
    const r = reader(path, head);
    await r.ready;
    expect(ensureFuigoLocalModel(`${SERVER.id}::${MODEL}`, { FUIGO_HOME: home, HOME: join(root, "home") })).toBe(slug);
    const now = readFileSync(path, "utf8");
    expect(now).toContain(`base_url = "${SERVER.apiBase}"`); // the rewrite really happened
    // Precondition, so the witness cannot pass vacuously: a read that straddles an in-place rewrite is neither file.
    const torn = old.slice(0, head) + now.slice(head);
    expect(torn).not.toBe(old);
    expect(torn).not.toBe(now);
    const seen = await r.finish();
    expect([old, now]).toContain(seen); // 76892ffe08 (in place): old head + new tail
  });

  it("a local pick still lands while another process holds config.toml open under the Windows rule (in-place fallback, no failed turn)", async () => {
    const home = join(root, "fuigo-home");
    const { path, old, slug } = seed(home);
    const head = old.indexOf("\n\n") + 1;
    const r = reader(path, head);
    await r.ready;
    uninstall = installWindowsReplaceRule();
    if (process.platform !== "win32") expect(heldByOtherProcess(path)).toBe(true);
    expect(ensureFuigoLocalModel(`${SERVER.id}::${MODEL}`, { FUIGO_HOME: home, HOME: join(root, "home") })).toBe(slug);
    const now = readFileSync(path, "utf8");
    expect(now).toContain(`base_url = "${SERVER.apiBase}"`);
    expect(now.length).toBeGreaterThan(head);
    // The legacy in-place writer lets a paused reader keep the old prefix and read the new suffix.
    const torn = old.slice(0, head) + now.slice(head);
    expect(torn).not.toBe(old);
    expect(torn).not.toBe(now);
    expect(await r.finish()).toBe(torn);
    expect(replaceAttempts(realpathSync(path))).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32")("keeps a dotfiles link a link, and the owner's file mode", () => {
    const home = join(root, "fuigo-home");
    const dotfiles = join(root, "dotfiles");
    const { path: real, slug } = seed(dotfiles);
    mkdirSync(home, { recursive: true });
    const link = join(home, "config.toml");
    symlinkSync(real, link);
    expect(ensureFuigoLocalModel(`${SERVER.id}::${MODEL}`, { FUIGO_HOME: home, HOME: join(root, "home") })).toBe(slug);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain(`base_url = "${SERVER.apiBase}"`);
    expect(statSync(real).mode & 0o777).toBe(0o644);
  });
});
