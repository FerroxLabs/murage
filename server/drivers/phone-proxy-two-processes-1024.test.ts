// SPDX-License-Identifier: AGPL-3.0-or-later
// A direct turn and a room turn each mount their own phone proxy. Two REAL proxies, spawned over stdio and sharing one phone, still
// keep a clear-and-type pair whole: the other proxy's key press waits for it.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { spawnBoundProxy } from "../testing/bound-proxy-fixture.ts";
import { freePortBlock } from "../testing/ports.ts";

const PROXY = fileURLToPath(new URL("./phone-proxy.ts", import.meta.url));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixtureAdb(dir: string) {
  const log = join(dir, "calls.log"), adb = join(dir, "adb");
  writeFileSync(adb, `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  devices*) printf 'List of devices attached\\nUSB_FIXTURE device model:Fixture\\n' ;;
  *"settings get"*) printf 'com.android.adbkeyboard/.AdbIME' ;;
  *dumpsys*) sleep 1; printf 'mServedInputConnection=ControlledInputConnection{active=true}' ;;
esac
`);
  chmodSync(adb, 0o755);
  return { log, adb };
}

async function mount(adb: string, handPort: number, waitMs?: number) {
  const child = await spawnBoundProxy("phone", process.execPath, [PROXY], { windowsHide: true, env: { PATH: process.env.PATH, MURAGE_ADB_PATH: adb, MURAGE_PHONE_HAND_PORT: String(handPort), ...(waitMs ? { MURAGE_PHONE_HAND_WAIT_MS: String(waitMs) } : {}) }, stdio: ["pipe", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  return {
    replies: () => output.trim().split("\n").filter(Boolean),
    call: (id: number, name: string, args: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`),
    close: async () => { child.stdin.end(); await new Promise((resolve) => child.once("close", resolve)); },
  };
}

it("keeps a clear-and-type pair whole when a second mounted proxy sends a key meanwhile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-two-"));
  try {
    const { log, adb } = fixtureAdb(dir);
    const handPort = await freePortBlock([0]);
    const direct = await mount(adb, handPort), room = await mount(adb, handPort);
    direct.call(1, "type_text", { text: "replacement", clear: true });
    for (let waited = 0; !existsSync(log) || !/dumpsys/.test(readFileSync(log, "utf8")); waited += 20) { if (waited > 15000) break; await wait(20); }
    room.call(1, "press", { key: "enter" });
    for (let waited = 0; (direct.replies().length < 1 || room.replies().length < 1) && waited < 20000; waited += 20) await wait(20);
    await direct.close(); await room.close();
    const lines = readFileSync(log, "utf8").split("\n").filter((line) => /ADB_CLEAR_TEXT|ADB_INPUT_B64|keyevent/.test(line));
    expect(lines.map((line) => /ADB_CLEAR_TEXT/.test(line) ? "clear" : /ADB_INPUT_B64/.test(line) ? "type" : "key")).toEqual(["clear", "type", "key"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 40000);

it("answers a retryable busy error and sends nothing to the phone when the lock cannot be had in time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-busy-"));
  const squatter = createServer();
  try {
    const { log, adb } = fixtureAdb(dir);
    await new Promise<void>((resolve) => squatter.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve));
    const proxy = await mount(adb, (squatter.address() as { port: number }).port, 500);
    proxy.call(1, "press", { key: "enter" });
    for (let waited = 0; proxy.replies().length < 1 && waited < 10000; waited += 20) await wait(20);
    const reply = JSON.parse(proxy.replies()[0] ?? "{}");
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toContain("busy");
    await proxy.close();
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toMatch(/keyevent/);
  } finally { squatter.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30000);
