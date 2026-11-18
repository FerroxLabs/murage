// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";
import { HostComputerBroker } from "./host-computer-broker.ts";
import { BUDGET_VERDICT, RELEASE_LIMITS, ReleaseBudget } from "./memory/release-budget.ts";
import { withUpstreamOwner } from "./memory/upstream-reader.ts";

// Inert MCP peer: it only returns protocol data and never performs a host action.
const observation = { content: [{ type: "text", text: "fixture observation" }] };
const initialized = JSON.stringify({ id: 1, result: {} }) + "\n";
const observed = JSON.stringify({ id: 2, result: observation }) + "\n";
function peer(malformed = false) {
  const source = `let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let end;
    while((end=buffer.indexOf('\\n'))>=0){const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      if(request.id===undefined)continue;
      const response=request.method==='initialize'?${JSON.stringify(initialized)}:${malformed ? JSON.stringify("invalid protocol data\n") : JSON.stringify(observed)};
      process.stdout.write(response);
    }});`;
  return { command: process.execPath, args: ["-e", source], env: {} };
}
function refusal() {
  return vi.fn((): never => { throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" }); });
}

it("the server-owned host transport charges raw replies without standalone proxy authority", async () => {
  const refuse = refusal(), budget = new ReleaseBudget(refuse);
  const broker = new HostComputerBroker();
  const result = await withUpstreamOwner({ budgets: [budget], refuse }, () =>
    broker.dispatch(peer(), "tools/call", { name: "fixture_observe" }, () => true));
  expect(result).toEqual(observation);
  expect(budget.counts.bytes).toBe(Buffer.byteLength(initialized + observed));
  expect(refuse).not.toHaveBeenCalled();
  await broker.drain();
});

it("the host transport exhausts the captured raw-byte budget before parsing an invalid reply", async () => {
  const refuse = refusal(), budget = new ReleaseBudget(refuse);
  budget.charge({ bytes: RELEASE_LIMITS.bytes - Buffer.byteLength(initialized) });
  const broker = new HostComputerBroker();
  await expect(withUpstreamOwner({ budgets: [budget], refuse }, () =>
    broker.dispatch(peer(true), "tools/call", { name: "fixture_observe" }, () => true))).rejects.toThrow(/refused|unavailable/);
  expect(refuse).toHaveBeenCalledWith(BUDGET_VERDICT);
  expect(budget.counts.bytes).toBe(RELEASE_LIMITS.bytes);
  // A malformed/missing action reply retains exclusion after cleanup.
  await expect(broker.drain()).rejects.toThrow("cleanup is unconfirmed");
});
