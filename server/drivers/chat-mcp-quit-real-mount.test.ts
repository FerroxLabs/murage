// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: the server's shutdown (graceful-shutdown.ts, quit-latch.ts) and the mount relay stop that ends a mount server's process
// group (cli-mount-relay.ts settle, chat-mcp-client.ts ChatMcpDescendants.ready). A mount server's stop waits for a process
// listing before it ends stdin and signals the group. That wait is as long as the whole shutdown allowance, so at Quit a listing
// that has not answered meant the server exited first and the mount server (and what it started in its group) outlived Murage.
// Everything here is real: the spawn, the group signal, the shutdown at its real allowance. Only the listing is held: a platform
// listTree hook (the Linux path with a hook, as on Murage Cloud) that never answers.
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createGracefulShutdown } from "../graceful-shutdown.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { setPlatformProcessHooks } from "../platform-process-hooks.ts";
import { resetServerQuitForTest } from "../quit-latch.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import type { SendTurnInput } from "../contracts.ts";

const cleanups: Array<() => void | Promise<unknown>> = [];
const started: number[] = [];
afterEach(async () => {
  // whatever a failing run left behind is ended here, never by the code under test
  for (const pid of started.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup(); } catch {} }
  setPlatformProcessHooks({});
  resetServerQuitForTest();
});

/** Running as itself: not gone (ESRCH) and not a zombie nobody reaped yet (it holds nothing). */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  // off Linux the exited children here are reaped at once (by this process, or by init for the helper)
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch { return false; }
};
const until = async (check: () => boolean, ms: number): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
};

it.skipIf(process.platform === "win32")("Quit while the mount server's process list is outstanding leaves no mount process alive when the server exits", async () => {
  // the listing never answers: not at startup, not at the stop
  setPlatformProcessHooks({ listTree: () => new Promise<number[] | undefined>(() => {}) });
  const scratch = mkdtempSync(join(tmpdir(), "murage-quit-mount-")); cleanups.push(() => removeTempDir(scratch));
  const pidFile = join(scratch, "mount.pids");
  // the mount server starts a helper in its own process group, then ignores stdin's end: only the group signal ends both
  const mountScript = [
    "const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs');",
    "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + helper.pid);`,
    "process.stdin.on('end', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);",
  ].join(" ");
  const f = consumingFixture(undefined, { botId: randomUUID() }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "isolated", cwd: scratch,
    warmIdentity: { botId: f.binding.identity.botId, audience: "owner" }, releaseBinding: f.binding, mountAdmission: admission };
  const relay = await CliMountRelay.create(turn, { one: { command: process.execPath, args: ["-e", mountScript], env: {} } },
    { one: { MURAGE_COMMS_TOKEN: "turn-secret" } }, cred);
  cleanups.push(() => relay.finish());
  await until(() => existsSync(pidFile) && /^\d+ \d+$/.test(readFileSync(pidFile, "utf8")), 5_000);
  const [mount, helper] = readFileSync(pidFile, "utf8").split(" ").map(Number) as [number, number];
  started.push(helper, mount);
  expect(alive(mount)).toBe(true);
  expect(alive(helper)).toBe(true);

  // the real shutdown at its real allowance. Its cleanup job reaches this relay a little after Quit began (other jobs first), so
  // the relay's listing wait begins inside the allowance and would end after it.
  const atExit = await new Promise<{ mount: boolean; helper: boolean }>((resolve) => {
    createGracefulShutdown({
      cleanup: [async () => { await new Promise((wait) => setTimeout(wait, 300)); await relay.finish(); }],
      // what the server's exit leaves running: from here on nothing in Murage can still signal anything
      exit: () => resolve({ mount: alive(mount), helper: alive(helper) }),
    })();
  });
  expect(atExit).toEqual({ mount: false, helper: false });
}, 30_000);

