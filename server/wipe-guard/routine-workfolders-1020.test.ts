// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 (owner-seen on 1.0.19): scheduled owner routines ended before the engine started with wipe-guard-invalid-turn. The log shape was
// a routine thread with carried outside input, a memory fence recovery that left parts out, "turn sent-to-dispatch", then the refusal.
// None of that reaches the delete check. Its only inputs are the thread id and the root list, and the owner install had 585 task work
// folders (each routine run and chat has its own under <data>/workspaces/<bot>/<task>), more than the 512 roots 1.0.19 accepted. So every
// owner No-limits turn was refused, routines first. These witnesses drive the REAL turn path (wipeGuardTurnEnvironment, the real registry,
// the real root list, the real guard server and the shipped client) at the owner install size and at four times it, and prove the delete
// check still asks the owner and still refuses everyone else.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { deliverWipeGuardTerminal, wipeGuardTurnEnvironment } from "../drivers/murage-exec-wipe.ts";
import { installWipeContextReader } from "../wipe/context.ts";
import { registeredWipeProjects } from "../wipe/registry.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { MAX_GUARD_FILE_BYTES, type GuardFile } from "./guard-file.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A routine owner turn on an install with `count` task work folders shaped like the real ones. */
async function routineTurn(count: number) {
  const parent = mkdtempSync(join(tmpdir(), "wg-routine-"));
  cleanups.push(() => removeTempDirSync(parent));
  const home = join(parent, "Users", "owner-of-this-mac"), dataDir = join(home, ".murage"), botId = randomUUID(), threadId = randomUUID();
  const folders: string[] = [], owners: string[] = [];
  for (let n = 0; n < count; n++) {
    const task = n === 0 ? threadId : randomUUID(), owner = `task:${botId}:${task}:cwd`, folder = join(dataDir, "workspaces", botId, task);
    owners.push(owner); folders.push(folder); registeredWipeProjects.replace(owner, [folder]);
  }
  cleanups.push(() => { for (const owner of owners) registeredWipeProjects.drop(owner); });
  mkdirSync(folders[0]!, { recursive: true }); mkdirSync(folders[1]!, { recursive: true });
  cleanups.push(installWipeContextReader(() => ({ cwd: folders[0], project: folders[0], home, dataDir })));
  const stop = new AbortController(); let cards = 0;
  // The routine turn as the scheduler sends it: owner audience, No limits, the task folder as cwd, no human text of its own.
  const turn = { threadId, text: "", cwd: folders[0]!, noLimits: true as const, routine: true,
    warmIdentity: { botId, audience: "owner" as "owner" | "non-owner", decidedOwner: true }, permissionNow: () => ({ noLimits: true as const }) };
  const start = () => wipeGuardTurnEnvironment({ turn, turnId: "turn", env: { PATH: process.env.PATH }, signal: stop.signal, isLive: () => true,
    subscribe: () => () => {}, posixShell: true, askWipe: async () => { cards++; return "deny"; } });
  cleanups.push(async () => {
    stop.abort();
    await new Promise<void>(resolve => { if (!deliverWipeGuardTerminal({ eventId: "t", provider: "claude" as const, createdAt: new Date().toISOString(), type: "turn.completed", threadId, turnId: "turn", ok: true }, () => resolve())) resolve(); });
  });
  const wipe = (target: string) => ({ v: 1, kind: "wipe-exec", id: randomUUID(), threadId, tool: "rm", argv: ["-rf", "--", target], cwd: parent, targets: [target] });
  const ask = (file: string, target: string) => new Promise<{ decision: string }>((resolve, reject) => {
    const data = JSON.parse(readFileSync(file, "utf8")) as GuardFile, socket = connect(data.socket); let text = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify({ ...wipe(target), token: data.token }) + "\n"));
    socket.on("data", chunk => { text += chunk; if (text.includes("\n")) { socket.destroy(); resolve(JSON.parse(text.split("\n")[0]!)); } });
  });
  return { folders, turn, start, wipe, ask, cards: () => cards };
}

describe.skipIf(process.platform === "win32")("1.0.20: an owner routine on an install with many task work folders", () => {
  it("dispatches at the owner install size (585 work folders), publishes every folder, asks the owner before a wipe and refuses others", async () => {
    const x = await routineTurn(585);
    const env = await x.start(); // 1.0.19: throws wipe-guard-invalid-turn here, before the engine starts
    const published = (JSON.parse(readFileSync(env.MURAGE_WIPE_GUARD!, "utf8")) as GuardFile).roots;
    for (const folder of x.folders) expect(published).toContain(folder);
    // the catastrophic form still cards for the owner: another task's whole work folder
    expect((await x.ask(env.MURAGE_WIPE_GUARD!, x.folders[1]!)).decision).toBe("deny");
    expect(x.cards()).toBe(1);
    // and is refused with no card once the turn is not the owner's
    x.turn.warmIdentity.audience = "non-owner";
    expect((await x.ask(env.MURAGE_WIPE_GUARD!, x.folders[1]!)).decision).toBe("deny");
    expect(x.cards()).toBe(1);
  });

  it("still dispatches at four times that (2,400 work folders) and the shipped client still reaches the owner card", async () => {
    const x = await routineTurn(2400);
    const env = await x.start(); // before: wipe-guard-file-too-large, the same refused turn
    const file = env.MURAGE_WIPE_GUARD!, bytes = readFileSync(file).byteLength;
    expect(bytes).toBeGreaterThan(256 * 1024); expect(bytes).toBeLessThanOrEqual(MAX_GUARD_FILE_BYTES);
    expect((JSON.parse(readFileSync(file, "utf8")) as GuardFile).roots).toEqual(expect.arrayContaining(x.folders));
    // the real shipped client reads this guard file and reaches the guard: the owner is asked (11 = guard unavailable)
    const run = await new Promise<number | null>(resolve => {
      spawn(process.execPath, [join(here, "client.mjs"), "wipe-exec", JSON.stringify(x.wipe(x.folders[1]!))],
        { env: { ...process.env, MURAGE_WIPE_GUARD: file }, stdio: "ignore" }).once("exit", code => resolve(code));
    });
    expect(run).not.toBe(11);
    expect(x.cards()).toBe(1);
  });

  it("the writer, the shipped client and the shell shim accept the same guard file size", () => {
    const client = /MAX_GUARD = (\d+) \* (\d+);/.exec(readFileSync(join(here, "client.mjs"), "utf8"))!;
    expect(Number(client[1]) * Number(client[2])).toBe(MAX_GUARD_FILE_BYTES);
    const shim = [...readFileSync(join(here, "shim", "guard-lib.sh"), "utf8").matchAll(/(?:wg_guard_text\}"|\+ 4\)\)) -le (\d+) \]/g)].map(m => Number(m[1]));
    expect(shim).toEqual([MAX_GUARD_FILE_BYTES, MAX_GUARD_FILE_BYTES]);
    expect(spawnSync("sh", ["-n", join(here, "shim", "guard-lib.sh")]).status).toBe(0);
  });
});
