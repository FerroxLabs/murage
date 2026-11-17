// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// arev-salv-x3restore-n3 Medium: a shell launch is registered only for the
// adapter call itself. A spend refusal, a stopped turn or any other dispatch
// failure before or at that call leaves no pending launch behind.
// Owners: the shell session registry and its sendProjectUsageTurn consumer = the X3 restore row (salv-x3restore*).
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ShellSessionRegistry } from "./shell-session-state.ts";

const launch = { thread: "thread", provider: "provider" };
/** A launch left behind would still turn a later acceptance into a live record. */
function retained(registry: ShellSessionRegistry, generation: string): boolean {
  registry.accept(generation, "T", "/proj");
  registry.started({ thread: "thread", provider: "provider", native: "n", incarnation: 1 }, "T");
  return registry.select("thread", "provider", "T") !== undefined;
}

it("a send that throws before the engine has the turn (spend refusal) leaves no launch", async () => {
  const registry = new ShellSessionRegistry();
  const refused = new Error("spend refused");
  await expect(registry.dispatch("g", launch, () => { throw refused; }, () => undefined)).rejects.toBe(refused);
  expect(retained(registry, "g")).toBe(false);
});

it("an adapter rejection leaves no launch", async () => {
  const registry = new ShellSessionRegistry();
  await expect(registry.dispatch("g", launch, () => Promise.reject(new Error("adapter")), () => undefined)).rejects.toThrow("adapter");
  expect(retained(registry, "g")).toBe(false);
});

it("an accepted turn seeds its record from the spawn folder", async () => {
  const registry = new ShellSessionRegistry();
  const accepted = await registry.dispatch("g", launch, async () => ({ turnId: "T", spawnCwd: "/proj" }), turn => turn.spawnCwd);
  expect(accepted.turnId).toBe("T");
  registry.started({ thread: "thread", provider: "provider", native: "n", incarnation: 1 }, "T");
  expect([...registry.select("thread", "provider", "T")!.state.targets.keys()]).toEqual(["/proj"]);
});

it("sendProjectUsageTurn registers its launch only at the adapter calls, after spend admission", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function sendProjectUsageTurn(");
  const end = source.indexOf("\nfunction abandonProjectUsageTurn(", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  expect(body).not.toContain("shellSessions.launch(");
  expect(body).toContain("shellSessions.dispatch(shellGeneration, shellLaunch, () => instance.adapter.sendTurn(input), spawnFolder)");
  expect(body).toContain("sharedOwnerUsageTurn(instance, turn, owner, fence, consumingBinding, sendShellTurn)");
  expect(source).toContain("const accepted = await dispatchSpendTurn(turn, fence, () => send(turn));");
  expect(body).toContain("dispatchSpendTurn(turn, fence, () => sendShellTurn(turn))");
  expect(body).toContain("dispatchSpendTurn(input, fence, () => sendShellTurn(input))");
});

it("the Chief proposal turn registers its launch through the same adapter-call dispatch", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(source).toContain("const sending = shellSessions.dispatch(proposalShellGeneration, { thread: threadId, provider: instance.instanceId }, () => sendBuiltTurn(instance.adapter, {");
  // the only launch registration left is inside the registry's dispatch
  expect(source).not.toContain("shellSessions.launch(");
});
