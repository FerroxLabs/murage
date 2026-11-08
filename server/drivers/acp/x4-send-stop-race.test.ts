// X4 stop path (Astra acct2 BLOCK on 159bca1eb, defect b): a Stop, reset, Stop All or dispose that lands while a send waits on the
// engine's version probe ends that send. The send captured its epoch before the wait, and the wait registers it where Stop All sees it.
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { openCodeDestinationAnswer } from "../../opencode-destination.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const roots: string[] = [];
const instances: ProviderInstance[] = [];
beforeEach(() => { ensureDirs(); });
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Variant = "spawnNeedsCliVersion" | "effectiveDestination";
it.each(["spawnNeedsCliVersion", "effectiveDestination"] as Variant[])("T-SEND-STOP-RACE: a stop during the %s version probe wait, then no spawn", async variant => {
  for (const action of ["interrupt", "reset", "stopAll", "dispose"] as const) {
    const root = mkdtempSync(join(tmpdir(), "x4-send-race-"));
    roots.push(root);
    const cli = join(root, `engine-${variant}-${action}.mjs`), gate = join(root, "gate"), probing = join(root, "probing"), started = join(root, "started");
    // `--version` announces itself and waits for the gate; any other start is a spawn.
    writeFileSync(cli, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  writeFileSync(${JSON.stringify(probing)}, 'x');
  while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 20));
  console.log('1.19.4'); process.exit(0);
}
writeFileSync(${JSON.stringify(started)}, 'x');
setInterval(() => {}, 1000);
`);
    chmodSync(cli, 0o755);
    const support: AcpSupport = { driverKind: "opencodeGo", displayName: "Fixture", defaultCli: cli, nativeSource: "fixture", loginNote: "fixture",
      models: { default: "p/m", options: [{ id: "p/m", label: "Fixture" }] }, spawnArgs: () => ["acp"], pickAuthMethod: () => null, isAuthenticated: () => true, authFailure: "continue",
      ...(variant === "spawnNeedsCliVersion" ? { spawnNeedsCliVersion: true } : { effectiveDestination: async () => openCodeDestinationAnswer({}, { model: "p/m", memoryOff: true }) }) };
    const instance = await createAcpDriver(support).create({ instanceId: "x4-race", displayName: "Fixture", enabled: true, environment: {}, config: { cli, fullAuto: false } });
    instances.push(instance);
    const send = instance.adapter.sendTurn({ threadId: "race", text: "fixture", model: "p/m" });
    const rejected = expect(send).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(existsSync(probing)).toBe(true), { timeout: 10_000 });
    if (action === "interrupt") await instance.adapter.interruptTurn("race");
    else if (action === "reset") await instance.adapter.resetSession?.("race");
    else if (action === "stopAll") await instance.adapter.stopAll?.();
    else await instance.dispose();
    writeFileSync(gate, "open");
    await rejected;
    expect(existsSync(started), `${variant}/${action}: the engine was spawned after the stop`).toBe(false);
  }
}, 60_000);
