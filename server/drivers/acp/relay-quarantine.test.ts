import { afterEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { fixtureMountTurn } from "../../testing/mcp-admission-fixture.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { recordEvents } from "../../testing/events.ts";
import { createAcpDriver } from "./core.ts";
import * as relay from "../cli-mount-relay.ts";
import * as procs from "../../procs.ts";
import type { ProviderInstance } from "../../contracts.ts";

let instance: ProviderInstance | undefined;
let release: (() => void) | undefined;
afterEach(async () => { release?.(); await instance?.dispose(); vi.restoreAllMocks(); });
async function pending() {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const wait = vi.spyOn(relay, "relayHoldReleased").mockImplementation(() => { entered(); return held; });
  const available = vi.spyOn(relay, "assertRelayAvailable").mockImplementation(() => { throw new Error("MOUNT_RELAY_STOP_UNCONFIRMED"); });
  const spawn = vi.spyOn(procs, "spawnCli");
  const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
  const driver = createAcpDriver({ driverKind: "quarantine-fixture", fluxReach: () => "elsewhere", displayName: "Fixture", defaultCli: cli,
    nativeSource: "fixture", models: { default: "fixture", options: [] }, loginNote: "fixture", spawnArgs: () => [],
    pickAuthMethod: () => null, isAuthenticated: () => true, authFailure: "continue" });
  instance = await driver.create({ instanceId: "quarantine-fixture", displayName: "Fixture", enabled: true, environment: {}, config: { cli, fullAuto: false } });
  const records = recordEvents(instance.adapter);
  const input = () => fixtureMountTurn({ threadId: "quarantine", cwd: fixtureBotFolder(), text: "fixture",
    integrations: { memory: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} } } });
  const sent = instance.adapter.sendTurn(input());
  void sent.catch(() => {});
  await waiting;
  return { sent, wait, available, spawn, records, input };
}
for (const action of ["interrupt", "reset", "stopAll", "dispose"] as const) {
  it(`Stop during relay quarantine settles promptly: ${action}`, async () => {
    const f = await pending();
    if (action === "interrupt") await instance!.adapter.interruptTurn("quarantine");
    else if (action === "reset") await instance!.adapter.resetSession!("quarantine");
    else if (action === "stopAll") await instance!.adapter.stopAll!();
    else await instance!.dispose();
    // Teardown is still held. Cancellation must release the reservation now.
    const outcome = await Promise.race([f.sent.then(value => ({ value }), error => ({ error })),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 500))]);
    expect(outcome).not.toBeNull();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.available).not.toHaveBeenCalled();
    if (action !== "dispose") {
      expect(f.records.events.map(e => e.type)).toEqual(["turn.started", "turn.completed"]);
      expect(f.records.events.at(-1)).toMatchObject({ stopReason: "cancelled" });
      f.wait.mockReturnValue(null);
      await expect(instance!.adapter.sendTurn(f.input())).rejects.toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
    }
  });
}
it("the next mounted send stays pending until teardown is confirmed, then checks quarantine", async () => {
  const f = await pending();
  let settled = false;
  void f.sent.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(settled).toBe(false);
  expect(f.available).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
  release!();
  await expect(f.sent).rejects.toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
  expect(f.available).toHaveBeenCalledOnce();
  expect(f.spawn).not.toHaveBeenCalled();
});
