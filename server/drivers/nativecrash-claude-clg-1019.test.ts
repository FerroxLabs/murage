// SPDX-License-Identifier: AGPL-3.0-or-later
// CLG witnesses (nativecrash G2): the transient pre-accept retry never relaunches a fenced turn.
//  (r) a turn refusal registered before the exit decision: no turn.retrying, no relaunch, the turn ends memory-refused.
//  (p) a revoke the decision cannot see: the relaunch's own fence refuses before its spawn at site "claude.relaunch.prepare".
import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ensureDirs } from "../config.ts";
import { ClaudeDriver } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { fencedRefusals as ringRefusals, fencedTurnInput, refusalFor, type FencedRefusal } from "./engine-input.ts";
import { buildPrompt, noneRef, promptPart } from "../memory/prompt-parts.ts";
import { checkedOpenTurns } from "../memory/lineage-write.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { recordEvents } from "../testing/events.ts";

const spawned = vi.hoisted(() => ({ onSpawn: undefined as undefined | (() => void), unwritten: 0 }));
vi.mock("../procs.ts", async original => {
  const api = await original<typeof import("../procs.ts")>();
  // the revoke lands on the first launch's exit, in a listener registered before the driver's: after its fences, before the retry decision
  return { ...api, spawnCli: (...args: Parameters<typeof api.spawnCli>) => { const child = api.spawnCli(...args);
    // a proven pre-accept failure (U-17): the first launch's pipe is unwritable, so its prompt is never written (claude.test.ts refusePromptsBeforePipe)
    if (args[1].includes("--input-format") && spawned.unwritten-- > 0) Object.defineProperty(child.stdin, "writable", { configurable: true, get: () => false });
    const hook = spawned.onSpawn; spawned.onSpawn = undefined; if (hook) child.once("exit", hook); return child; } };
});

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const fencedRefusals = () => ringRefusals() as readonly unknown[] as readonly FencedRefusal[];
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  spawned.onSpawn = undefined; spawned.unwritten = 0;
  vi.unstubAllEnvs(); resetClaudeVersionGate();
});

async function rig(register: boolean | null) {
  ensureDirs();
  chmodSync(FAKE_CLI, 0o755);
  const root = mkdtempSync(join(tmpdir(), "nc-clg-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "launches");
  vi.stubEnv("FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS", "1"); vi.stubEnv("FAKE_CLAUDE_STATE", state);
  vi.stubEnv("FAKE_CLAUDE_RETRY_SCALE", "0.001");
  const instance = await ClaudeDriver.create({ instanceId: randomUUID(), displayName: "isolated CLG", enabled: true,
    environment: { FAKE_CLAUDE_MCP_BASELINE_MS: "2000" }, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } });
  const events = recordEvents(instance.adapter);
  cleanup.push(async () => { events.stop(); await instance.dispose(); });
  spawned.unwritten = 1;
  const threadId = randomUUID(), botId = randomUUID();
  const f = consumingFixture(undefined, { threadId, botId }); cleanup.push(() => f.close());
  const input = fencedTurnInput({ threadId, cwd: root, draftOnly: true, releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart("clg", [noneRef("owner-turn")])]) },
  { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! });
  if (register !== null) spawned.onSpawn = () => {
    f.flip();
    // (r) the lease's revoke outside any fence call registers the turn's R (R.noClaim at J0) before the exit is read
    if (register) refusalFor(Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" }), "lease.ledger",
      { engine: "claude", threadId, binding: f.binding, kind: "turn", target: undefined });
  };
  const sent = await instance.adapter.sendTurn(input);
  const done = await events.until((e: any) => e.type === "turn.completed" && e.turnId === sent.turnId);
  const mine = fencedRefusals().filter(r => r.threadId === threadId);
  const launches = existsSync(state) ? readFileSync(state, "utf8") : "0";
  return { events, done, mine, launches };
}

it("CLG control: with no revoke the pre-accept exit is retried once and the relaunch completes", async () => {
  const x = await rig(null);
  expect(x.events.events.filter((e: any) => e.type === "turn.retrying").length).toBe(1);
  expect(x.launches).toBe("2");
  expect(x.done).toMatchObject({ ok: true });
}, 30_000);

it("CLG (r): a turn refusal registered before the pre-accept exit decision ends the turn memory-refused with no relaunch", async () => {
  const x = await rig(true);
  expect(x.events.events.filter((e: any) => e.type === "turn.retrying"), "a fenced turn is never retried").toEqual([]);
  expect(x.launches, "one launch: no relaunch of a fenced turn").toBe("1");
  expect(x.done).toMatchObject({ ok: false, stopReason: "memory-refused" });
  expect(x.mine.map(r => [r.site, r.kind])).toEqual([["lease.ledger", "turn"]]);
}, 30_000);

it("CLG (p): a revoke the decision cannot see is refused by the relaunch's own fence at claude.relaunch.prepare, before any spawn", async () => {
  const x = await rig(false);
  expect(x.events.events.filter((e: any) => e.type === "turn.retrying").length, "the decision saw no refusal: one retry").toBe(1);
  expect(x.launches, "the relaunch is refused before its spawn").toBe("1");
  expect(x.mine.map(r => r.site), "one record at the relaunch's prepare fence").toEqual(["claude.relaunch.prepare"]);
  expect(x.done).toMatchObject({ ok: false });
}, 30_000);
