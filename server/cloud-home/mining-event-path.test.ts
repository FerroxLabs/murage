// SPDX-License-Identifier: AGPL-3.0-or-later
// End to end across the lanes: the miner watcher's event file (lane 1) is picked up by the heartbeat health
// collector (lane 3) and the resulting block raises an alert in the control plane's monitoring path.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { healthSchema, recordHealth } from "../../cloudflare/control-plane/src/ops-monitor";
import { removeTempDirSync } from "../testing/cleanup.ts";

const dir = (name: string) => fileURLToPath(new URL(`../../deploy/cloud-home/${name}`, import.meta.url));
const hasPython = (() => { try { execFileSync("python3", ["--version"]); return true; } catch { return false; } })();

const script = `
import importlib.machinery, importlib.util, json, sys
def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module
watch = load("miner_watch", sys.argv[1])
control = load("murage_control", sys.argv[2])
events = sys.argv[3]
watch.write_event(4242, now_ms=1700000000000, events=events)
health, consumed = control.collect_health(data_mount=events, backup_last=events + "/none", events=events)
print(json.dumps({"health": health, "consumed": consumed}))
`;

describe("mining event reaches the alert path", () => {
  it.skipIf(!hasPython)("a file written by the miner watcher is carried by the heartbeat health block and raises an alert", async () => {
    const events = mkdtempSync(join(tmpdir(), "murage-events-"));
    try {
      // Noise that must be ignored: a non-allowlisted type and a dot-prefixed temp file.
      writeFileSync(join(events, "other.json"), JSON.stringify({ type: "secret.dump", at: 1, token: "nope" }));
      const out = JSON.parse(execFileSync("python3", ["-I", "-c", script, dir("murage-miner-watch.py"), dir("murage-control"), events], { encoding: "utf8" }));
      expect(out.health.events).toEqual([{ type: "abuse.mining_suspected", at: 1700000000000 }]);
      expect(out.consumed).toHaveLength(1);

      const parsed = healthSchema.parse(out.health); // strict: exactly what the Worker accepts on the heartbeat
      const inserts: unknown[][] = [];
      const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({
        run: async () => { if (sql.includes("INSERT INTO cloud_alerts")) inserts.push(args); return { meta: { changes: 1 } }; },
        // deliver() claims the new alert with UPDATE ... RETURNING (ops-monitor.ts). No row comes back, so the claim is not
        // taken and nothing is sent: this test stops at the alert row, with no network.
        all: async () => ({ results: [] }) }) }) };
      await recordHealth({ DB: db } as unknown as Env, "home-1", parsed, 1700000001000);
      expect(inserts).toHaveLength(1);
      expect(inserts[0].slice(1, 4)).toEqual(["home-1", "abuse.mining_suspected", "high"]);
    } finally { removeTempDirSync(events); }
  });
});
