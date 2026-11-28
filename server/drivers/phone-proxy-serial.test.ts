// SPDX-License-Identifier: AGPL-3.0-or-later
// The real phone proxy, spawned over stdio, runs concurrent tool calls one at a time: a clear-and-type pair never has another call between its steps.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { spawnBoundProxy } from "../testing/bound-proxy-fixture.ts";

const PROXY = fileURLToPath(new URL("./phone-proxy.ts", import.meta.url));

it("keeps a clear-and-type pair whole when another call arrives while it waits on the device", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-serial-"));
  try {
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
    const child = await spawnBoundProxy("phone", process.execPath, [PROXY], { windowsHide: true, env: { PATH: process.env.PATH, MURAGE_ADB_PATH: adb }, stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    const replies = () => output.trim().split("\n").filter(Boolean);
    const call = (id: number, name: string, args: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    call(1, "type_text", { text: "replacement", clear: true });
    call(2, "press", { key: "enter" });
    for (let waited = 0; replies().length < 2 && waited < 15000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    child.stdin.end();
    await new Promise((resolve) => child.once("close", resolve));
    const lines = readFileSync(log, "utf8").split("\n").filter((line) => /ADB_CLEAR_TEXT|ADB_INPUT_B64|keyevent/.test(line));
    expect(lines.map((line) => /ADB_CLEAR_TEXT/.test(line) ? "clear" : /ADB_INPUT_B64/.test(line) ? "type" : "key")).toEqual(["clear", "type", "key"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);
