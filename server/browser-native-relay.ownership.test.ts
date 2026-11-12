import { removeTempDirSync } from "./testing/cleanup.ts";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeOwnedBrowser, ownedCloseCli } from "./browser-owned-close.ts";
import { createNativeBrowser } from "./browser-native-relay.ts";
vi.mock("./browser-sandbox.ts", () => ({ ensureBrowserSandboxAccess: async () => {} }));
const linuxIt = it.skipIf(process.platform !== "linux");
afterEach(() => vi.restoreAllMocks());
const launchId = "0123456789abcdef";
const good = { launchId, closed: true, path: "forced", saveStatus: "lost",
  groupExhausted: true, treeExhausted: true, outsideSeen: 0, unconfirmed: null };
async function fixture() {
  mkdirSync(".ownership-fixtures", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".ownership-fixtures/cli-"));
  // This sentinel is unrelated to the expected daemon; no successful control
  // depends on keeping the daemon alive through final confirmation.
  const sentinel = spawn("/usr/bin/sleep", ["60"], { stdio: "ignore" });
  await once(sentinel, "spawn");
  const spec = { command: process.execPath, args: [], env: { HOME: dir,
    AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "fixture", AGENT_BROWSER_LAUNCH_ID: launchId } };
  const ownerFile = join(dir, "fixture.owner.json");
  writeFileSync(ownerFile, JSON.stringify({ v: 1, session: "fixture", launchId,
    daemon: { pid: sentinel.pid! + 1, start: "1", exe: spec.command }, group: { kind: "sid", id: 123 } }));
  return { spec, ownerFile, sentinel, async cleanup() {
    if (sentinel.exitCode === null && sentinel.signalCode === null) { const exit = once(sentinel, "exit"); sentinel.kill(); await exit; }
    removeTempDirSync(dir);
  } };
}
for (const [arm, proof, code] of [
  ["close_refused", { ...good, closed: false, unconfirmed: "tree_lingering" }, 3],
  ["reused", { ...good, closed: false, error: "orphans_remain" }, 3],
  ["wrong_stop_launch", { ...good, launchId: "fedcba9876543210" }, 0],
  ["closed_false", { ...good, closed: false }, 0],
  ["tree_false", { ...good, treeExhausted: false }, 0],
] as const) {
  linuxIt(`A5 ownership close refuses ${arm} through the close-owned boundary`, async () => {
    const f = await fixture();
    const run = vi.spyOn(ownedCloseCli, "run");
    try {
      // Matching-launch, fully confirmed control must succeed first.
      run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(good) });
      await expect(createNativeBrowser(f.spec).close()).resolves.toBeUndefined();
      run.mockResolvedValueOnce({ code, stdout: JSON.stringify(proof) });
      await expect(createNativeBrowser(f.spec).close()).rejects.toThrow();
      expect(run).toHaveBeenLastCalledWith(f.spec, launchId);
      expect(f.sentinel.exitCode).toBeNull(); expect(f.sentinel.signalCode).toBeNull();
    } finally { await f.cleanup(); }
  });
}
linuxIt("ownership close retains its successful receipt for a repeated close", async () => {
  const f = await fixture();
  try {
    const run = vi.spyOn(ownedCloseCli, "run").mockResolvedValue({ code: 0, stdout: JSON.stringify(good) });
    const browser = createNativeBrowser(f.spec); await browser.close(); await browser.close();
    expect(run).toHaveBeenCalledTimes(1);
  } finally { await f.cleanup(); }
});
linuxIt("stale-token recovery never retries a CLI after ownership close is refused", async () => {
  const f = await fixture();
  try {
    vi.spyOn(ownedCloseCli, "run").mockResolvedValue({ code: 3, stdout: JSON.stringify({ ...good, closed: false, error: "launch_mismatch" }) });
    const calls = join(f.spec.env.HOME, "calls"); const cli = join(f.spec.env.HOME, "cli.mjs");
    writeFileSync(cli, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(calls)}, "call\\n"); console.error("control_token_mismatch"); process.exit(1);`);
    const browser = createNativeBrowser(f.spec, { cliPrefix: [cli] });
    await expect(browser.command(["status"])).rejects.toThrow();
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
  } finally { await f.cleanup(); }
});
for (const mode of ["no_pid", "dead_daemon", "daemon_exits_with_descendant"] as const) {
  linuxIt(`N2 A5 integrated close refuses missing owner evidence: ${mode}`, async () => {
    mkdirSync(".ownership-fixtures", { recursive: true });
    const dir = mkdtempSync(join(process.cwd(), ".ownership-fixtures/missing-"));
    const spec = { command: process.execPath, args: [], env: { HOME: dir,
      AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "fixture",
      AGENT_BROWSER_LAUNCH_ID: "0123456789abcdef" } };
    // The helper survives daemon exit but has a private inherited pipe so cleanup
    // can release it without signalling a recorded numeric PID.
    const daemon = spawn(process.execPath, ["-e", `
      const { spawn } = require('node:child_process');
      const helper = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
        { stdio: [3, 'ignore', 'ignore'] });
      console.log(helper.pid);
      process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
    `], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    const helperPid = Number(String((await once(daemon.stdout!, "data"))[0]).trim());
    const release = daemon.stdio[3] as import("node:stream").Writable;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (mode !== "no_pid") writeFileSync(join(dir, "fixture.pid"), String(daemon.pid));
      if (mode !== "daemon_exits_with_descendant") {
        const exited = once(daemon, "exit"); daemon.stdin!.end(); await exited;
      } else {
        exitTimer = setTimeout(() => daemon.stdin!.end(), 150);
      }
      const browser = createNativeBrowser(spec);
      // Capture outcome first: assert the live descendant even on today's false success.
      const outcome = await browser.close().then(() => "closed", () => "refused");
      const helperStat = readFileSync(`/proc/${helperPid}/stat`, "utf8");
      expect(helperStat.slice(helperStat.lastIndexOf(")") + 1).trim().split(/\s+/u)[0]).not.toBe("Z");
      expect(outcome, "daemon exit is not tree exhaustion for an ownership launch").toBe("refused");
    } finally {
      if (exitTimer) clearTimeout(exitTimer);
      release.end();
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exited = once(daemon, "exit"); daemon.stdin!.end(); await exited;
      }
      removeTempDirSync(dir);
    }
  });
}

linuxIt("N2 direct owned-close refuses an ownership launch with no owner and no daemon PID", async () => {
  mkdirSync(".ownership-fixtures", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".ownership-fixtures/direct-"));
  try {
    const run = vi.spyOn(ownedCloseCli, "run");
    await expect(closeOwnedBrowser({ command: process.execPath, args: [], env: {
      AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "fixture",
      AGENT_BROWSER_LAUNCH_ID: "0123456789abcdef",
    } }, null)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  } finally { removeTempDirSync(dir); }
});

linuxIt("ownership close checks the launch group even when its pid file is missing", async () => {
  const f = await fixture();
  try {
    const run = vi.spyOn(ownedCloseCli, "run").mockResolvedValue({ code: 0, stdout: JSON.stringify(good) });
    await expect(createNativeBrowser(f.spec).close()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledExactlyOnceWith(f.spec, launchId);
    expect(f.sentinel.exitCode).toBeNull(); expect(f.sentinel.signalCode).toBeNull();
  } finally { await f.cleanup(); }
});
linuxIt("ownership close requires launch-bound exhaustion after close refusal", async () => {
  const f = await fixture();
  try {
    const run = vi.spyOn(ownedCloseCli, "run").mockResolvedValue({ code: 0, stdout: JSON.stringify(good) });
    await expect(createNativeBrowser(f.spec).close()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledExactlyOnceWith(f.spec, launchId);
    run.mockResolvedValue({ code: 0, stdout: JSON.stringify({ ...good, groupExhausted: false }) });
    await expect(createNativeBrowser(f.spec).close()).rejects.toThrow();
    expect(f.sentinel.exitCode).toBeNull(); expect(f.sentinel.signalCode).toBeNull();
  } finally { await f.cleanup(); }
});
