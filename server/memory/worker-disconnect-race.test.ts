// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// INTEL-SMOKE-WORKER-EXIT: Murage closing the channel while the helper is still reporting (idle maintenance, an index result)
// made a send fail with EPIPE, and the unhandled "error" event ended the helper with code 1 before it closed its index.
// A real helper process here: the channel really closes under it. Each acknowledgement below is a send into that closing channel.
import { fork } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

async function closeWhileReporting() {
  const child = fork(resolve("server/memory/worker.ts"), [], { windowsHide: true, execArgv: ["--experimental-strip-types", "--no-warnings"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", data => { stderr += data; });
  const stderrClosed = new Promise<void>(done => child.stderr!.once("close", () => done()));
  await new Promise<void>((ready, failed) => {
    child.once("message", () => ready());
    child.once("exit", code => failed(new Error(`helper exited before ready: ${code}\n${stderr}`)));
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once("exit", (code, signal) => done({ code, signal })));
  for (let i = 0; i < 300; i++) child.send({ type: "checkpoint", requestId: `c${i}` });
  child.disconnect();
  const result = await exited;
  await stderrClosed;
  return { ...result, stderr };
}

it("a helper still reporting when the channel closes exits cleanly through its disconnect handler", async () => {
  for (let round = 0; round < 3; round++) expect(await closeWhileReporting()).toEqual({ code: 0, signal: null, stderr: "" });
}, 60_000);
