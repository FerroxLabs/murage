// 1.0.10 C3 through Claude's own ask path: a permission card that spans a
// suspension is not denied at the wake; it is denied once its full deadline
// of awake time has passed (createPermissionBroker, the 15-minute deny shrunk
// to 400 ms here).
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sleepClock } from "../sleep-clock.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { createPermissionBroker } from "./claude.ts";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(process.platform === "win32")("Claude permission card across a sleep", () => {
  afterEach(() => { sleepClock.resume(); sleepClock.stop(); });

  it("is not denied at the wake; it is denied after its awake deadline", async () => {
    sleepClock.start();
    const dir = mkdtempSync(join(tmpdir(), "murage-sleep-deadline-"));
    const resolved: Array<{ source: string; at: number }> = [];
    const broker = await createPermissionBroker({
      socketPaths: [join(dir, "sleep.sock")],
      timeoutMs: 400,
      onAsk: () => {},
      onResolve: ask => resolved.push({ source: ask.source, at: Date.now() }),
    });
    try {
      const conn = connect(broker.socketPath);
      await new Promise<void>((resolve, reject) => { conn.on("connect", resolve); conn.on("error", reject); });
      conn.write(JSON.stringify({ t: "ask", id: "slept", tool: "Bash", input: { command: "echo hi" } }) + "\n");
      await wait(100);
      sleepClock.suspend();
      await wait(1_000);
      expect(resolved).toEqual([]);
      const wokeAt = Date.now();
      sleepClock.resume();
      await wait(150);
      expect(resolved).toEqual([]);
      await expect.poll(() => resolved.length, { timeout: 3_000 }).toBe(1);
      expect(resolved[0]!.source).toBe("timeout");
      // about 300 ms of the 400 were left at the suspension
      expect(resolved[0]!.at - wokeAt).toBeGreaterThanOrEqual(250);
      conn.end();
    } finally {
      broker.close();
      removeTempDirSync(dir);
    }
  });
});
