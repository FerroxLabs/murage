import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createNativeBrowser } from "./browser-native-relay.ts";

vi.mock("./browser-sandbox.ts", () => ({ ensureBrowserSandboxAccess: async () => {} }));

const linuxIt = it.skipIf(process.platform !== "linux");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(arm: "close_refused" | "reused" | "wrong_stop_launch" | "success") {
  mkdirSync(".ownership-fixtures", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".ownership-fixtures/f-"));
  const child = spawn("/usr/bin/sleep", ["60"], { env: { HOME: dir }, stdio: "ignore" });
  await once(child, "spawn");
  const servers: Server[] = [];
  cleanups.push(async () => {
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
    rmSync(dir, { recursive: true, force: true });
  });
  const pid = child.pid!;
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const start = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u)[19]}`;
  const launchId = "0123456789abcdef";
  writeFileSync(join(dir, "fixture.pid"), String(pid));
  writeFileSync(join(dir, "fixture.owner.json"), JSON.stringify({ v: 1, session: "fixture", launchId,
    daemon: { pid, start: arm === "reused" ? "old-start" : start, exe: readlinkSync(`/proc/${pid}/exe`) }, group: { kind: "sid", id: pid } }));
  const commands: unknown[] = [];
  async function listen(ext: string, reply: object) {
    const server = createServer(socket => {
      socket.on("error", () => {});
      socket.on("data", data => { commands.push(JSON.parse(String(data))); socket.end(JSON.stringify(reply) + "\n"); });
    });
    servers.push(server);
    server.listen(join(dir, `fixture.${ext}`)); await once(server, "listening");
  }
  await listen("sock", { success: false, error: "close_refused" });
  await listen("stop", { launchId: arm === "wrong_stop_launch" ? "fedcba9876543210" : launchId,
    groupExhausted: arm === "success", treeExhausted: arm === "success", outsideSeen: 0, unconfirmed: arm === "success" ? null : "tree_lingering" });
  const browser = createNativeBrowser({ command: "/usr/bin/sleep", args: [], env: { AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "fixture", AGENT_BROWSER_LAUNCH_ID: launchId } });
  return { browser, child, commands, dir };
}
for (const arm of ["close_refused", "reused", "wrong_stop_launch"] as const) {
  linuxIt(`ownership close preserves the sentinel and refuses ${arm}`, async () => {
    const { browser, child, commands } = await fixture(arm);
    await expect(browser.close()).rejects.toThrow();
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    if (arm === "reused") expect(commands).toEqual([]);
  });
}
linuxIt("ownership close uses the launch-bound stop channel after close refusal", async () => {
  const { browser, child, commands } = await fixture("success");
  await expect(browser.close()).resolves.toBeUndefined();
  expect(commands).toContainEqual({ launchId: "0123456789abcdef" });
  expect(commands[0]).toMatchObject({ action: "close", closeOnly: true, launchId: "0123456789abcdef", requireSaved: false });
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
});

linuxIt("ownership close retains its successful receipt for a repeated close", async () => {
  const { browser, child, commands } = await fixture("success");
  await browser.close();
  child.kill(); await once(child, "exit");
  await expect(browser.close()).resolves.toBeUndefined();
  expect(commands).toHaveLength(2);
});
linuxIt("stale-token recovery never retries a CLI after ownership close is refused", async () => {
  const { dir } = await fixture("reused");
  const calls = join(dir, "calls");
  const cli = join(dir, "cli.mjs");
  writeFileSync(cli, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(calls)}, "call\\n"); console.error("control_token_mismatch"); process.exit(1);`);
  const browser = createNativeBrowser({ command: process.execPath, args: [], env: { HOME: dir, AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "fixture", AGENT_BROWSER_LAUNCH_ID: "0123456789abcdef" } }, { cliPrefix: [cli] });
  await expect(browser.command(["status"])).rejects.toThrow();
  expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
});
