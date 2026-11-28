// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: ACP driver mounted MCP gate (acp/core.ts, the marker wait of engines with no per-server list), lane q1024-acpready.
// Consumer: direct-turn ledger lease (ledger-refusal.ts), which alone decides between a refusal row and a confirmed Stop.
// 1.0.24 acpready (Astra tip audit 01a40ecea3 High 2; MAIN: owner turns are never refused for tool readiness, start with what is ready):
// Gemini, OpenCode, Droid, Kimi and Qwen name no per-server list; Murage's own servers prove themselves by their ready markers. When a
// required mount stayed live but wrote no marker before the deadline, the marker branch refused the turn before the owner fallback (which
// sat inside the list branch) was ever reached. These rows run the real Gemini driver on the engine's real wire (fake ACP engine process
// that connects to every handed server, real mount relay and children, real fenced submit), one row per required mount that can miss.
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents } from "../../testing/events.ts";
import { fixtureMountTurn } from "../../testing/mcp-admission-fixture.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { resetAcpMcpReadinessForTests } from "./core.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import * as native from "../engine-input.ts";

const CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const REFUSAL_LINE = "I stopped this turn because some of its context is no longer available.";
let root: string, instance: ProviderInstance | undefined;
let wire: any[];
beforeEach(() => {
  resetAcpMcpReadinessForTests();
  ensureDirs(); chmodSync(CLI, 0o755);
  root = mkdtempSync(join(tmpdir(), "acpready-marker-"));
  vi.stubEnv("FAKE_ACP_RPC_LOG", join(root, "rpc.jsonl"));
  vi.stubEnv("MURAGE_ACP_MCP_LISTED_MS", "1500");
  wire = [];
  const submit = native.fencedSubmit;
  // Observation only: every frame still goes through the real fenced submit.
  vi.spyOn(native, "fencedSubmit").mockImplementation((turn, write, serialized, validate) =>
    submit(turn, () => {
      if (serialized) wire.push(JSON.parse(serialized));
      return write();
    }, serialized, validate));
});
afterEach(async () => {
  await instance?.dispose(); instance = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await removeTempDir(root);
});
async function create(connect: boolean) {
  instance = await GeminiAgentDriver.create({ instanceId: "acpready-marker", displayName: "Gemini", enabled: true,
    environment: { HOME: root, USERPROFILE: root, GEMINI_API_KEY: "fixture-only", FAKE_ACP_MODE: "happy", FAKE_ACP_MODELS: "fixture-model",
      ...(connect ? { FAKE_ACP_MCP_CONNECT: "1" } : {}) },
    config: GeminiAgentDriver.decodeConfig({ cli: CLI, fullAuto: false }) });
  return recordEvents(instance.adapter);
}
/** A live server that never writes its ready marker (the marker deadline runs out with it still up). */
const SILENT = ["-e", "process.stdin.resume()"];
/** A live server that writes its ready marker at once. */
const MARKS = ["-e", "require('node:fs').writeFileSync(process.env.MURAGE_MCP_LISTED_FILE, String(Date.now())); process.stdin.resume()"];
const OWNER = { audience: "owner" as const, decidedOwner: true };
const UNDECIDED = { audience: "owner" as const, decidedOwner: false };
type Row = { id: string; memory: string[]; agents?: string[]; composio?: string[]; connect: boolean; told: RegExp };
// One row per required mount that can miss the marker deadline while it stays live (SITES.md S1): memory, agents, connected apps
// (core.ts requiredMountNames), and two at once.
const ROWS: Row[] = [
  { id: "memory-silent", memory: SILENT, connect: true, told: /^Murage couldn't use the memory for this reply\.$/ },
  { id: "agents-silent", memory: MARKS, agents: SILENT, connect: true, told: /^Murage couldn't use the messaging other bots for this reply\.$/ },
  { id: "connected-apps-silent", memory: MARKS, composio: SILENT, connect: true, told: /^Murage couldn't use the connected apps for this reply\.$/ },
  { id: "both-silent", memory: SILENT, agents: SILENT, connect: true, told: /^Murage couldn't use the (memory and messaging other bots|messaging other bots and memory) for this reply\.$/ },
];
const turnFor = (audience: typeof OWNER, row: Row) => fixtureMountTurn({
  threadId: `acpready-${row.id}`, cwd: root, text: "hello", warmIdentity: { botId: "acpready-bot", ...audience },
  integrations: { memory: { command: process.execPath, args: row.memory, env: {} }, ...(row.agents ? { agents: { command: process.execPath, args: row.agents, env: {} } } : {}),
    ...(row.composio ? { composio: { command: process.execPath, args: row.composio, env: {} } } : {}) } });
const prompts = () => wire.filter(frame => frame.method === "session/prompt");
const refusalLines = (records: { events: any[] }) => records.events.filter(event => event.type === "runtime.error" && event.message === REFUSAL_LINE);
const toldTitle = (records: { events: any[] }) => String(records.events.find(event => event.type === "item.started" && /^Murage couldn't use the /.test(String(event.title ?? "")))?.title ?? "");
const completion = (records: Awaited<ReturnType<typeof create>>, turnId: string) => records.until(e => e.type === "turn.completed" && e.turnId === turnId, 40_000);

describe("1.0.24 acpready: a marker-only engine's owner turn is never refused for a required mount that missed its marker deadline", () => {
  for (const row of ROWS) {
    it(`A1-${row.id}: the decided owner's Gemini turn is prompted and completes, no refusal row, the bot told what is missing`, async () => {
      const records = await create(row.connect);
      const sent = await instance!.adapter.sendTurn(turnFor(OWNER, row));
      const done = (await completion(records, sent.turnId)) as { ok?: boolean };
      expect({ ok: done.ok, refusals: refusalLines(records).length, prompts: prompts().length, told: row.told.test(toldTitle(records)) })
        .toEqual({ ok: true, refusals: 0, prompts: 1, told: true });
    }, 60_000);
  }
  // Guards (fail closed, unchanged from base): only a decided owner lets an unproven mount go; every other audience is still refused.
  for (const row of ROWS) {
    it(`G1-${row.id}: a turn whose owner audience is not decided is still refused, nothing prompted`, async () => {
      const records = await create(row.connect);
      const sent = await instance!.adapter.sendTurn(turnFor(UNDECIDED, row));
      const done = (await completion(records, sent.turnId)) as { ok?: boolean; stopReason?: string };
      expect({ ok: done.ok, stopReason: done.stopReason, prompts: prompts().length }).toEqual({ ok: false, stopReason: "memory-refused", prompts: 0 });
    }, 60_000);
  }
  // Every mount proven by its marker: the owner's turn runs and nothing is let go (no notice), as on base.
  it("A2-all-marked: an owner turn whose mounts all wrote their markers runs with no unavailable notice", async () => {
    const row: Row = { id: "all-marked", memory: MARKS, agents: MARKS, connect: true, told: /./ };
    const records = await create(true);
    const sent = await instance!.adapter.sendTurn(turnFor(OWNER, row));
    const done = (await completion(records, sent.turnId)) as { ok?: boolean };
    expect({ ok: done.ok, prompts: prompts().length, told: toldTitle(records) }).toEqual({ ok: true, prompts: 1, told: "" });
  }, 60_000);
});
