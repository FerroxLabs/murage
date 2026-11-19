import { fixtureLearningBot } from "../testing/learning-bot-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// T-H1 (designs MEM-S1-H1-SENDLOCK-1019 section 2), adapter level, for the turn engines (Codex app-server, ACP): the same competing-hide
// race as learning-send-race.p1.test.ts. The seam is each adapter's lowest prompt-byte primitive, the child's stdin.write: on the frame
// that carries the learning prompt (Codex turn/start, ACP session/prompt) it runs, synchronously and before handing the bytes over, a
// hide on a second real connection (busy_timeout 0), then records what happened. With the frame written inside the gate's lock the hide
// gets SQLITE_BUSY and commits only after the gate's COMMIT; on the base (admit committed, then the adapter wrote) the hide commits
// first and the hidden words still leave. That base run is the defect.
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { CodexDriver } from "../drivers/codex.ts";
import { GrokAgentDriver } from "../drivers/acp/grok.ts";
import { learningGate, sampleLearningFence } from "./learning-send.ts";

const MARKER = "zqh1enginemarker";
const seam = vi.hoisted(() => ({ onPrompt: null as null | (() => void), frame: "" }));
vi.mock("../procs.ts", async (original) => {
  const actual = await original<typeof import("../procs.ts")>();
  return {
    ...actual,
    spawnCli: (...args: Parameters<typeof actual.spawnCli>) => {
      const child = actual.spawnCli(...args);
      const stdin = child.stdin as unknown as { write: (...a: unknown[]) => unknown } | null;
      if (stdin) {
        const write = stdin.write.bind(stdin);
        stdin.write = (...a: unknown[]) => {
          const chunk = typeof a[0] === "string" ? a[0] : Buffer.isBuffer(a[0]) ? a[0].toString("utf8") : "";
          if (seam.onPrompt && seam.frame && chunk.includes(MARKER) && chunk.includes(`"method":"${seam.frame}"`)) {
            const run = seam.onPrompt;
            seam.onPrompt = null;
            run();
          }
          return write(...a);
        };
      }
      return child;
    },
  };
});

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { seam.onPrompt = null; seam.frame = ""; vi.unstubAllEnvs(); closeDatabase(); });

const testing = (name: string) => fileURLToPath(new URL(`../testing/${name}`, import.meta.url));
const made: ProviderInstance[] = [];
afterEach(async () => { for (const instance of made.splice(0)) await instance.dispose().catch(() => undefined); });

const ENGINES = [
  ["Codex app-server", "turn/start", async () => {
    const cli = testing("fake-codex-app-server.ts");
    chmodSync(cli, 0o755);
    return CodexDriver.create({ instanceId: "codex-race", displayName: "Codex", environment: {}, enabled: true, config: { cli, fullAuto: false } });
  }],
  ["ACP (grokAgent)", "session/prompt", async () => {
    const cli = testing("fake-acp-cli.ts");
    chmodSync(cli, 0o755);
    return GrokAgentDriver.create({ instanceId: "acp-race", displayName: "ACP", environment: {}, enabled: true, config: { cli, fullAuto: false } });
  }],
] as const;

async function learner(create: () => Promise<ProviderInstance>) {
  const instance = await create();
  fixtureLearningBot(instance);
  made.push(instance);
  expect(instance.extractMemory).toBeTypeOf("function");
  return instance.extractMemory!.bind(instance);
}
const other = () => { const db = new DatabaseSync(join(DATA_DIR, "messages.db")); db.exec("PRAGMA busy_timeout=0"); return db; };
const hide = (db: DatabaseSync, id: string) => db.exec(`INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('scope','${id}',1,1)`);

describe.each(ENGINES)("T-H1: the prompt frame holds the gate's lock (%s)", (_name, frame, create) => {
  it("a hide committed on another connection while the prompt frame is being written waits for the COMMIT: no hidden bytes leave after it", async () => {
    const extract = await learner(create);
    database();
    const gate = learningGate("extraction", sampleLearningFence());
    const second = other();
    const order: string[] = [];
    try {
      seam.frame = frame;
      seam.onPrompt = () => {
        try { hide(second, "h1-race"); order.push("hide-committed"); }
        catch (error) { expect(String((error as Error).message)).toMatch(/locked|busy/i); order.push("hide-busy"); }
        order.push("bytes");
      };
      await extract(`The owner keeps ${MARKER} private.`, 2000, new AbortController().signal, { fence: gate } as never).catch(() => undefined);
      // the frame left only while the gate held BEGIN IMMEDIATE; the hide could not commit in between
      expect(order).toEqual(["hide-busy", "bytes"]);
      hide(second, "h1-race");
      expect(gate.released).toBe(1);
    } finally { second.close(); }
  }, 60_000);

  it("(c) a hide committed before the check: the gate refuses and no prompt frame is written", async () => {
    const extract = await learner(create);
    database();
    const gate = learningGate("extraction", sampleLearningFence());
    const second = other();
    let wrote = 0;
    try {
      hide(second, "h1-before");
      seam.frame = frame;
      seam.onPrompt = () => { wrote++; };
      await expect(extract(`The owner keeps ${MARKER} private.`, 2000, new AbortController().signal, { fence: gate } as never)).rejects.toBeTruthy();
      expect(wrote).toBe(0);
      expect(gate.released).toBe(0);
    } finally { second.close(); }
  }, 60_000);
});
