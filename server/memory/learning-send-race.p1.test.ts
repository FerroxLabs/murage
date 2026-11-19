import { fixtureLearningBot } from "../testing/learning-bot-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// T-H1 (designs MEM-S1-H1-SENDLOCK-1019 section 2), adapter level: a hide another connection commits while a learning call is between
// the gate's check and the prompt bytes leaving. The seam is the adapter's lowest prompt-byte primitive, the child's stdin.end: on the
// prompt it runs, synchronously and before handing the bytes over, a hide on a second real connection (busy_timeout 0), then records
// what happened. With the write inside the gate's lock the hide gets SQLITE_BUSY and commits only after the gate's COMMIT; on the base
// (admit committed, then the adapter wrote) the hide commits first and the hidden words still leave. That base run is the defect.
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ClaudeDriver } from "../drivers/claude.ts";
import { resolveLearningConnection } from "./extractor-connections.ts";
import { learningGate, learningSendHoldSamples, sampleLearningFence } from "./learning-send.ts";

const MARKER = "zqh1racemarker";
const seam = vi.hoisted(() => ({ onPrompt: null as null | (() => void) }));
vi.mock("../procs.ts", async (original) => {
  const actual = await original<typeof import("../procs.ts")>();
  return {
    ...actual,
    spawnCli: (...args: Parameters<typeof actual.spawnCli>) => {
      const child = actual.spawnCli(...args);
      const stdin = child.stdin as unknown as { write: (...a: unknown[]) => unknown } | null;
      if (stdin) {
        const write = stdin.write.bind(stdin);
        stdin.write = (...a: unknown[]) => { if (typeof a[0] === "string" && a[0].includes(MARKER)) seam.onPrompt?.(); return write(...a); };
      }
      return child;
    },
  };
});

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { seam.onPrompt = null; vi.unstubAllEnvs(); closeDatabase(); });

const fake = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
const made: ProviderInstance[] = [];
afterEach(async () => { for (const instance of made.splice(0)) await instance.dispose().catch(() => undefined); });
async function claude() {
  chmodSync(fake, 0o755);
  vi.stubEnv("FAKE_CLAUDE_ONE_SHOT_TEXT", "```json\n[]\n```");
  const instance = await ClaudeDriver.create({ instanceId: "claude-fixture", displayName: "Claude", environment: {}, enabled: true, config: { cli: fake, permissionMode: "acceptEdits" } });
  fixtureLearningBot(instance);
  made.push(instance);
  return resolveLearningConnection({ selected: instance.instanceId, instances: [instance], readKey: () => null, defaultOn: true }).extractor!;
}
const other = () => { const db = new DatabaseSync(join(DATA_DIR, "messages.db")); db.exec("PRAGMA busy_timeout=0"); return db; };
const hide = (db: DatabaseSync, id: string) => db.exec(`INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('scope','${id}',1,1)`);

describe("T-H1: the prompt write holds the gate's lock (Claude runner)", () => {
  it("a hide committed on another connection while the prompt is being written waits for the COMMIT: no hidden bytes leave after it", async () => {
    const extractor = await claude();
    database();
    const gate = learningGate("extraction", sampleLearningFence());
    const second = other();
    const order: string[] = [];
    try {
      seam.onPrompt = () => {
        try { hide(second, "h1-race"); order.push("hide-committed"); }
        catch (error) { expect(String((error as Error).message)).toMatch(/locked|busy/i); order.push("hide-busy"); }
        order.push("bytes");
      };
      await extractor(`The owner keeps ${MARKER} private.`, 2000, new AbortController().signal, { fence: gate } as never).catch(() => undefined);
      // (a)+(b): the bytes left only while the gate held BEGIN IMMEDIATE; the hide could not commit in between
      expect(order).toEqual(["hide-busy", "bytes"]);
      hide(second, "h1-race");
      expect(gate.released).toBe(1);
      const holds = [...learningSendHoldSamples()].sort((a, b) => a - b);
      const at = (q: number) => holds[Math.min(holds.length - 1, Math.floor(q * holds.length))];
      console.info(`h1-sendlock noteHold samples=${holds.length} p50_ms=${at(0.5)} p99_ms=${at(0.99)}`);
    } finally { second.close(); }
  }, 30_000);

  it("(c) a hide committed before the check: the gate refuses and no prompt bytes are written", async () => {
    const extractor = await claude();
    database();
    const gate = learningGate("extraction", sampleLearningFence());
    const second = other();
    let wrote = 0;
    try {
      hide(second, "h1-before");
      seam.onPrompt = () => { wrote++; };
      await expect(extractor(`The owner keeps ${MARKER} private.`, 2000, new AbortController().signal, { fence: gate } as never)).rejects.toBeTruthy();
      expect(wrote).toBe(0);
      expect(gate.released).toBe(0);
    } finally { second.close(); }
  }, 30_000);
});
