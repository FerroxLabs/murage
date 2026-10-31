// 1.0.10 C3 through Claude's own ask path: a question card that spans a
// suspension is not answered at the wake; its honest non-answer comes once its
// full wait of awake time has passed (createPermissionBroker, the 30-minute
// question wait shrunk to its 1 s floor here). A permission card has no
// deadline at all since fix/1010-grok-stopped, so it stays open across the
// sleep and after it.
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sleepClock } from "../sleep-clock.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { createPermissionBroker } from "./claude.ts";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const QUESTION = { questions: [{ question: "Which folder?", header: "Folder", options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }], multiSelect: false }] };

describe.skipIf(process.platform === "win32")("Claude cards across a sleep", () => {
  afterEach(() => { sleepClock.resume(); sleepClock.stop(); });

  it("a question is not answered at the wake; it times out after its awake wait, and a permission card never does", async () => {
    sleepClock.start();
    const dir = mkdtempSync(join(tmpdir(), "murage-sleep-deadline-"));
    const resolved: Array<{ id: string; source: string; at: number }> = [];
    const broker = await createPermissionBroker({
      socketPaths: [join(dir, "sleep.sock")],
      questionTimeoutMs: 1_000,
      onAsk: () => {},
      onResolve: ask => resolved.push({ id: ask.id, source: ask.source, at: Date.now() }),
    });
    try {
      const conn = connect(broker.socketPath);
      await new Promise<void>((resolve, reject) => { conn.on("connect", resolve); conn.on("error", reject); });
      conn.write(JSON.stringify({ t: "ask", id: "slept-question", kind: "question", tool: "AskUserQuestion", input: QUESTION }) + "\n");
      conn.write(JSON.stringify({ t: "ask", id: "slept-permission", tool: "Bash", input: { command: "echo hi" } }) + "\n");
      await wait(100);
      sleepClock.suspend();
      await wait(1_500);
      expect(resolved).toEqual([]);
      const wokeAt = Date.now();
      sleepClock.resume();
      await wait(150);
      expect(resolved).toEqual([]);
      await expect.poll(() => resolved.length, { timeout: 3_000 }).toBe(1);
      expect(resolved[0]!.id).toBe("slept-question");
      expect(resolved[0]!.source).toBe("timeout");
      // about 900 ms of the 1000 were left at the suspension
      expect(resolved[0]!.at - wokeAt).toBeGreaterThanOrEqual(700);
      // the permission card is still open: it waits for the owner
      await wait(1_200);
      expect(resolved.map(r => r.id)).toEqual(["slept-question"]);
      expect(broker.answer("slept-permission", "deny")).toBe(true);
      conn.end();
    } finally {
      broker.close();
      removeTempDirSync(dir);
    }
  });
});
