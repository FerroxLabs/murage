// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.24 q1024-linuxmem witness (MAIN-RULING memory; ASTRA on 197c943acf: server/proxy-turn-release.ts verdict and its refusal): the
// harness has answered the bot's memory_save (the save landed), and the release door cannot be reached for the release of that
// answer. The answer still reaches the bot and the mount stays open: the turn is not stopped after a save that landed, and the save
// is not sent a second time. One row per door call the reply's release makes: its verdict, the reservation of the verdict's answer,
// and the reservation of the envelope. Every row calls the tool over stdio MCP on the real spawned memory proxy
// (server/drivers/memory-proxy.ts handleMessage), bound to the turn release; the fixture door drops the connection of the named
// calls three times (one more than every other role's door client tries).
import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { spawnBoundProxy, boundProxyState, boundTerminalReason } from "../testing/bound-proxy-fixture.ts";

type Json = Record<string, any>;
type DoorCall = { kind: "verdict" | "reserve"; verdicts: number };
const SAVED = { ok: true, state: "active", id: "fixture-memory" };
const SAVE = { text: "the boat is moored at pier four", evidence: [{ quote: "the boat is moored at pier four" }], idempotencyKey: "linuxmem-reply-door-1" };
const open: { stub: Server; child: ChildProcess }[] = [];
afterEach(async () => {
  for (const { stub, child } of open.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    stub.closeAllConnections();
    await new Promise<void>(resolve => stub.close(() => resolve()));
  }
});

/** A harness stub that answers every memory request with the saved answer, and the real memory proxy spawned against it behind a
 * release door that drops the connection of every call `drops` names. */
async function rig(drops: (call: DoorCall) => boolean) {
  const bodies: Json[] = [];
  let dropped = 0;
  const stub = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => { bodies.push(JSON.parse(raw)); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(SAVED)); });
  });
  await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
  const address = stub.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const env: NodeJS.ProcessEnv = { ...process.env, MURAGE_HARNESS_URL: `http://127.0.0.1:${address.port}`, MURAGE_MEMORY_TOKEN: "fixture-memory-capability" };
  const child = await spawnBoundProxy("memory", process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./memory-proxy.ts", import.meta.url))],
    { env, stdio: ["pipe", "pipe", "pipe"], dropDoor: call => { if (!drops(call)) return false; dropped++; return true; } });
  open.push({ stub, child });
  let buffered = "", answer: (value: Json | "closed") => void = () => {};
  child.stdout!.on("data", chunk => {
    buffered += chunk.toString();
    for (let end; (end = buffered.indexOf("\n")) >= 0;) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (line.trim()) answer(JSON.parse(line) as Json);
    }
  });
  const call = (name: string, args: Json) => new Promise<Json | "closed">(resolve => {
    answer = resolve;
    child.once("close", () => resolve("closed"));
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  return { child, bodies, call, dropped: () => dropped };
}
const text = (reply: Json | "closed") => reply === "closed" ? "closed" : reply.result?.content?.[0]?.text;

/** The first `count` calls that `match` are dropped. */
const first = (count: number, match: (call: DoorCall, seen: number) => boolean) => {
  let seen = 0, taken = 0;
  return (call: DoorCall) => match(call, seen++) && taken++ < count;
};
// `verdicts` is how many verdicts the door has answered: 0 while the reply's own verdict is still being asked, 1 for the reservations
// that follow it (the verdict's answer first, then the envelope).
const SITES: [site: string, tool: string, args: Json, drops: () => (call: DoorCall) => boolean][] = [
  ["the verdict of a save's answer", "memory_save", SAVE, () => first(3, call => call.kind === "verdict")],
  ["the reservation of the verdict's answer", "memory_save", SAVE, () => first(3, call => call.kind === "reserve" && call.verdicts === 1)],
  ["the reservation of the envelope", "memory_save", SAVE, () => { let passed = false; return first(3, call => call.kind === "reserve" && call.verdicts === 1 && (passed || !(passed = true))); }],
  ["the verdict of a search's answer", "memory_search", { query: "pier" }, () => first(3, call => call.kind === "verdict")],
];
for (const [site, tool, args, drops] of SITES) {
  it(`${tool}: a release door that cannot be reached three times for ${site}; the answer reaches the bot and the turn keeps running`, async () => {
    const { child, bodies, call, dropped } = await rig(drops());
    const reply = await call(tool, args);
    expect({ dropped: dropped(), sealed: boundProxyState(child).sealed, answer: text(reply), sent: bodies.length }, "the door dropped three calls, the mount is open (the turn is not stopped), the bot reads the answer, and the request was sent once").toEqual({ dropped: 3, sealed: false, answer: JSON.stringify(SAVED), sent: 1 });
  }, 60_000);
}

it("control: a release door that is never reached again for a save's answer still seals the mount when the frame's wait ends (bounded, never a loop)", async () => {
  const { child, bodies, call, dropped } = await rig(call => call.kind === "verdict");
  const reply = await call("memory_save", SAVE);
  expect({ sealed: boundProxyState(child).sealed, reason: boundTerminalReason(child), answer: text(reply), sent: bodies.length, asked: dropped() > 3 }).toEqual({ sealed: true, reason: "verdict-timeout", answer: "closed", sent: 1, asked: true });
}, 150_000);
