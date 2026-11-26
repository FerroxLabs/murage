// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cause22 caps witness child (server/cause22-owner-caps-proxy-1021.test.ts). A spawned proxy as the mount relay starts one: release
// environment, stdout for envelopes, IPC for acknowledgements. It runs the REAL proxy-turn-release.ts and does what its plan says with
// the same calls every bundled proxy makes (releaseProxyFrame, sendProxyFrame, proxyFetch, collectProxyUpstream), then reports each
// step's outcome to the test over IPC. It decides nothing about caps itself.
import { collectProxyUpstream, proxyFetch, releaseProxyFrame, sendProxyFrame } from "../proxy-turn-release.ts";

type Step =
  | { op: "frame"; id: number; bytes: number }
  | { op: "fetch"; url: string }
  | { op: "collect"; bytes: number }
  | { op: "burst"; count: number; padBytes?: number };
const ROLE = "custom";
const report = (value: Record<string, unknown>) => { try { process.send?.({ type: "fixture-report", ...value }); } catch { /* the parent is gone */ } };
const word = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? (error as Error | null)?.message ?? "error");

async function run(step: Step): Promise<Record<string, unknown>> {
  if (step.op === "frame") {
    await releaseProxyFrame(ROLE, { jsonrpc: "2.0", id: step.id, result: { content: [{ type: "text", text: "s".repeat(step.bytes) }] } });
    return { released: step.id };
  }
  if (step.op === "fetch") {
    const response = await proxyFetch(ROLE, step.url);
    let bytes = 0;
    const reader = response.body!.getReader();
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; }
    return { bytes };
  }
  if (step.op === "collect") {
    const piece = Buffer.alloc(64 * 1024, 0x63);
    const stream = (async function* () { for (let sent = 0; sent < step.bytes; sent += piece.length) yield piece.subarray(0, Math.min(piece.length, step.bytes - sent)); })();
    return { bytes: (await collectProxyUpstream(ROLE, stream)).length };
  }
  // every frame is handed over in the same tick, before any verdict can come back
  const pad = step.padBytes ? "p".repeat(step.padBytes) : undefined;
  for (let n = 0; n < step.count; n++) sendProxyFrame(ROLE, { jsonrpc: "2.0", method: "notifications/progress", params: { progress: n, ...(pad ? { pad } : {}) } });
  await releaseProxyFrame(ROLE, { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "burst-end" } });
  return { queued: step.count };
}

const plan = JSON.parse(process.env.FIXTURE_PLAN ?? "[]") as Step[];
// keep the entry alive while steps run; the release module owns stdin/IPC loss
const alive = setInterval(() => {}, 1000);
void (async () => {
  // as every proxy does first: one small frame (the answer to `initialize`), which is also when the door first says whose turn this is
  // FIXTURE_COLD=1: no such frame, so the plan's first step runs before the door has answered anything (r2: a burst handed over cold)
  if (process.env.FIXTURE_COLD !== "1") { try { await releaseProxyFrame(ROLE, { jsonrpc: "2.0", id: 0, result: { ready: true } }); } catch (error) { report({ step: -1, error: word(error) }); } }
  for (const [index, step] of plan.entries()) {
    try { report({ step: index, op: step.op, ...(await run(step)) }); }
    catch (error) { report({ step: index, op: step.op, error: word(error) }); }
  }
  report({ done: true });
  clearInterval(alive);
})();
