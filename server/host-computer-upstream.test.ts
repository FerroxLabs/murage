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

// "MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn": before, the invalid reply was refused by crossing
// the 64 MiB raw-byte budget; now the captured budget is sealed (a work crossing with no accepted release) after initialize and before
// the action is sent, and the sealed budget must still refuse the invalid reply before it is parsed or counted.
it("the host transport refuses on the captured sealed budget before parsing an invalid reply", async () => {
  const refuse = refusal(), budget = new ReleaseBudget(refuse);
  let checks = 0;
  const authorize = () => {
    if (++checks === 2) expect(() => budget.charge({ work: RELEASE_LIMITS.work + 1 })).toThrow("MEMORY_CONTEXT_REVOKED");
    return true;
  };
  const broker = new HostComputerBroker();
  await expect(withUpstreamOwner({ budgets: [budget], refuse }, () =>
    // r8 (C8 / D16 a): the cut ends the child under a started action, so the call answers driver-lost sent:true (the
    // action may have partly happened) and main is told; before C8 it was the transport's generic refusal text
    broker.dispatch(peer(true), "tools/call", { name: "fixture_observe" }, authorize))).rejects.toMatchObject({ status: 409, code: "driver-lost", sent: true });
  expect(refuse).toHaveBeenCalledWith(BUDGET_VERDICT);
  expect(budget.refused).toBe(true);
  expect(budget.counts.bytes).toBe(Buffer.byteLength(initialized));
  // A malformed/missing action reply retains exclusion after cleanup.
  await expect(broker.drain()).rejects.toThrow("cleanup is unconfirmed");
});

it("a kept turn session charges each call's raw reply to that call's owner", async () => {
  // Echoes the request id, so one child can answer several calls.
  const source = `let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let end;
    while((end=buffer.indexOf('\\n'))>=0){const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      if(request.id===undefined)continue;
      process.stdout.write(JSON.stringify({id:request.id,result:request.method==='initialize'?{}:${JSON.stringify(observation)}})+'\\n');
    }});`;
  const echo = { command: process.execPath, args: ["-e", source], env: {} };
  const reply = (id: number, result: unknown) => Buffer.byteLength(JSON.stringify({ id, result }) + "\n");
  const first = refusal(), firstBudget = new ReleaseBudget(first);
  const second = refusal(), secondBudget = new ReleaseBudget(second);
  const broker = new HostComputerBroker();
  const session = { key: "fixture-turn", owner: "fixture-bot" };
  await withUpstreamOwner({ budgets: [firstBudget], refuse: first }, () =>
    broker.dispatch(echo, "tools/call", { name: "fixture_observe" }, () => true, undefined, session));
  await withUpstreamOwner({ budgets: [secondBudget], refuse: second }, () =>
    broker.dispatch(echo, "tools/call", { name: "fixture_observe" }, () => true, undefined, session));
  // One child: the handshake is charged once, to the call that opened it.
  expect(firstBudget.counts.bytes).toBe(reply(1, {}) + reply(2, observation));
  expect(secondBudget.counts.bytes).toBe(reply(3, observation));
  await broker.drain();
});

it("a kept turn session charges bytes the driver sends between calls to that turn, never to nobody", async () => {
  // Replies, then sends a notification a moment later while no call is open.
  const note = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "fixture idle note" } }) + "\n";
  const source = `let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let end;
    while((end=buffer.indexOf('\\n'))>=0){const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      if(request.id===undefined)continue;
      process.stdout.write(JSON.stringify({id:request.id,result:request.method==='initialize'?{}:${JSON.stringify(observation)}})+'\\n');
      if(request.method==='tools/call')setTimeout(()=>process.stdout.write(${JSON.stringify(note)}),20);
    }});`;
  const noisy = { command: process.execPath, args: ["-e", source], env: {} };
  const reply = (id: number, result: unknown) => Buffer.byteLength(JSON.stringify({ id, result }) + "\n");
  const refuse = refusal(), budget = new ReleaseBudget(refuse);
  const broker = new HostComputerBroker();
  await withUpstreamOwner({ budgets: [budget], refuse }, () =>
    broker.dispatch(noisy, "tools/call", { name: "fixture_observe" }, () => true, undefined, { key: "fixture-turn", owner: "fixture-bot" }));
  await expect.poll(() => budget.counts.bytes).toBe(reply(1, {}) + reply(2, observation) + Buffer.byteLength(note));
  await broker.drain();
});
