// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 group B, rows S1/S3/S4 of cause22-eng-design3-fable/DESIGN.md (owner lane cause22-eng). One engine stdout line longer than
// any string the runtime can hold (the REAL limit, buffer.constants.MAX_STRING_LENGTH) reaches the real ACP driver through
// adapter.sendTurn (testing/cause22-fit-acp-child.fixture.ts) from the scripted fake engine behind the pad rig
// (testing/cause22-fit-pad.fixture.mjs). The driver runs in a child process: on the base the line throws inside the stdout data
// listener and the child dies without a result, which fails here at the row's first assertion (design BASE-RED RULE).
import { spawn } from "node:child_process";
import { constants } from "node:buffer";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDirSync } from "../../testing/cleanup.ts";

const CHILD = fileURLToPath(new URL("../../testing/cause22-fit-acp-child.fixture.ts", import.meta.url));
const LIMIT = constants.MAX_STRING_LENGTH;
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

type Turn = { ok: boolean; replyLength: number; replyHead: string; replyHasMarker: boolean; replyStartsWithMiB: boolean; replyTextCut: boolean; errors: string[]; notices: number };
type Report = { turns?: Turn[]; marks?: string[]; scriptLog?: string; failed?: string };
function runChild(home: string, plan: { script: unknown[]; second?: boolean }): Promise<{ report: Report | undefined; diag: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CHILD], { stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, CAUSE22_FIT_HOME: home, CAUSE22_FIT_PLAN: JSON.stringify(plan), CAUSE22_PAD_UNITS: String(LIMIT + 1), CAUSE22_PADH_UNITS: String(300_000_000) } });
    let report: Report | undefined;
    let stderr = "";
    child.on("message", (m: any) => { if (m?.type === "fixture-report") report = m; });
    child.stderr!.on("data", (c) => { stderr = (stderr + String(c)).slice(-3000); });
    child.stdout!.on("data", () => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), 280_000);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ report, diag: `child exit ${code ?? signal}; failed=${report?.failed ?? ""}; stderr tail: ${stderr}` }); });
  });
}
const home = () => { const dir = mkdtempSync(join(tmpdir(), "murage-fit-acp-")); dirs.push(dir); return dir; };
const chunk = (at: number, text: string) => ({ at, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });

describe("S1 the turn's only reply chunk is longer than any string (real limit)", () => {
  it("the turn completes with the first 1 MiB and a visible marker, the owner is told once, the turn is marked, a 2nd turn on the same process completes", async () => {
    const { report, diag } = await runChild(home(), { script: [chunk(1, "@@PAD@@"), { at: 50, result: { stopReason: "end_turn" } }], second: true });
    expect(report?.turns?.[0]?.ok, diag).toBe(true);
    const [first, second] = report!.turns!;
    expect(first!.replyStartsWithMiB).toBe(true);
    expect(first!.replyHasMarker).toBe(true);
    expect(first!.replyLength).toBeLessThan(2 * 1024 * 1024);
    expect(first!.notices).toBe(1);
    expect(report!.marks).toContain("outside tool:acp-line-fitted");
    expect(second?.ok, JSON.stringify(second?.errors)).toBe(true);
  }, 300_000);
});

describe("S3 a request to us longer than any string is refused by its exact id, never run", () => {
  it("the 300-character id gets -32000; the file is not written; the small request id 8 is answered; the turn completes", async () => {
    const dir = home();
    const longId = `req-${"7".repeat(296)}`;
    const script = [
      { at: 1, request: { id: longId, method: "fs/write_text_file", params: { path: join(dir, "cut.txt"), content: "@@PAD@@" } } },
      { at: 5, request: { id: 8, method: "fs/write_text_file", params: { path: join(dir, "small.txt"), content: "small" } } },
      { after: 8, at: 10, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } },
      { after: 8, at: 30, result: { stopReason: "end_turn" } },
    ];
    const { report, diag } = await runChild(dir, { script });
    expect(report?.turns?.[0]?.ok, diag).toBe(true);
    const answers = report!.scriptLog!.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: unknown; error?: { code?: number; message?: string } | null });
    const long = answers.find((a) => a.id === longId);
    expect(long?.error?.code, report!.scriptLog).toBe(-32000);
    expect(long?.error?.message).toMatch(/too large to send/);
    expect(existsSync(join(dir, "cut.txt"))).toBe(false);
    expect(answers.some((a) => a.id === 8)).toBe(true);
  }, 300_000);
});

describe("S4 the session/prompt reply itself is longer than any string", () => {
  it("the prompt resolves with the engine's own stopReason (no rejection) and the idle process serves the next turn", async () => {
    const script = [chunk(1, "short reply"), { at: 30, result: { stopReason: "end_turn", _meta: { trace: "@@PAD@@" } } }];
    const { report, diag } = await runChild(home(), { script, second: true });
    expect(report?.turns?.[0]?.ok, diag).toBe(true);
    expect(report!.turns![0]!.errors.join(" | ")).not.toMatch(/reject/i);
    expect(report!.turns![1]?.ok, JSON.stringify(report!.turns![1]?.errors)).toBe(true);
  }, 300_000);
});

describe("S1c (OPUS H1 on the design) two reply chunks a string can each hold, but not together", () => {
  it("the turn completes; the reply keeps its head below the limit with the marker; the turn is marked once", async () => {
    const script = [chunk(1, "@@PADH@@"), chunk(2, "@@PADH@@"), { at: 50, result: { stopReason: "end_turn" } }];
    const { report, diag } = await runChild(home(), { script });
    expect(report?.turns?.[0]?.ok, diag).toBe(true);
    const turn = report!.turns![0]!;
    expect(turn.replyTextCut).toBe(true);
    expect(turn.replyLength).toBeLessThan(LIMIT);
    expect(turn.replyLength).toBeGreaterThan(400_000_000);
    expect(report!.marks!.filter((m) => m === "outside tool:acp-reply-text-cut")).toHaveLength(1);
  }, 300_000);
});
