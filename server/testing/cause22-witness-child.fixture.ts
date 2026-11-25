// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cause22 witness child (server/cause22-owner-hops-witness-1021.test.ts). A spawned proxy as the mount relay starts one: release
// environment, stdout for envelopes, IPC for acknowledgements. It runs the REAL proxy-turn-release.ts and the REAL remote-mcp-proxy.ts
// transport (relayDeps / gatedFetch, wired with the same ports its main() passes), does what its plan says and reports each step's
// outcome to the test over IPC. It decides nothing about caps itself.
import * as release from "../proxy-turn-release.ts";

type Step =
  | { op: "frame"; id: number; bytes: number }
  | { op: "fetch"; url: string }
  | { op: "remote"; url: string };
const ROLE = "remoteMcp";
const report = (value: Record<string, unknown>) => { try { process.send?.({ type: "fixture-report", ...value }); } catch { /* the parent is gone */ } };
const word = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? (error as Error | null)?.message ?? "error");
async function drain(response: Response): Promise<number> {
  let bytes = 0;
  const reader = response.body!.getReader();
  for (;;) { const next = await reader.read(); if (next.done) return bytes; bytes += next.value.byteLength; }
}

async function run(step: Step): Promise<Record<string, unknown>> {
  if (step.op === "frame") {
    await release.releaseProxyFrame(ROLE, { jsonrpc: "2.0", id: step.id, result: { content: [{ type: "text", text: "s".repeat(step.bytes) }] } });
    return { released: step.id };
  }
  if (step.op === "fetch") return { bytes: await drain(await release.proxyFetch(ROLE, step.url)) };
  // the remote MCP relay transport alone (its session machine is not started: the mark below keeps main() from running)
  (globalThis as Record<symbol, unknown>)[Symbol.for("murage.remote-mcp-proxy.session-only")] = true;
  const { relayDeps } = await import("../drivers/remote-mcp-proxy.ts");
  // exactly the ports remote-mcp-proxy.ts main() passes; `owner` is the door's word on whose turn this is, where the build has one
  const ownerTurn = (release as Record<string, unknown>).proxyOwnerTurn as ((role: string) => boolean) | undefined;
  const deps = relayDeps(step.url, () => "fixture-relay-token", {
    fetch: (url, init) => fetch(url, init),
    reserve: bytes => release.reserveProxyUpstream(ROLE, bytes),
    lost: reason => release.proxyTransportLost(ROLE, reason),
    ...(ownerTurn ? { owner: () => ownerTurn(ROLE) } : {}),
  } as Parameters<typeof relayDeps>[2]);
  const response = await deps.post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "screenshot", arguments: {} } },
    AbortSignal.timeout(120_000), undefined as unknown as string, undefined as unknown as string, () => true);
  return { bytes: await drain(response as Response) };
}

const plan = JSON.parse(process.env.FIXTURE_PLAN ?? "[]") as Step[];
// keep the entry alive while steps run; the release module owns stdin/IPC loss
const alive = setInterval(() => {}, 1000);
void (async () => {
  // as every proxy does first: one small frame (the answer to `initialize`), which is also when the door first says whose turn this is
  try { await release.releaseProxyFrame(ROLE, { jsonrpc: "2.0", id: 0, result: { ready: true } }); } catch (error) { report({ step: -1, error: word(error) }); }
  for (const [index, step] of plan.entries()) {
    try { report({ step: index, op: step.op, ...(await run(step)) }); }
    catch (error) { report({ step: index, op: step.op, error: word(error) }); }
  }
  report({ done: true });
  clearInterval(alive);
})();
