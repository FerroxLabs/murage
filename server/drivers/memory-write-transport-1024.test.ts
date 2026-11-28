// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.24 memhold witness (MAIN-RULING memory, LINUXMEM-1023): a lost transport on the bot's own memory write never stops the owner's
// turn and never drops the write. On 1.0.23 a dropped connection or a 5xx on memory_save sealed the memory mount (proxyTransportLost):
// the turn stopped with "some of its context is no longer available" and the save was gone. Real spawned proxy, real HTTP stub.
import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { spawnBoundProxy, boundProxyState } from "../testing/bound-proxy-fixture.ts";

type Json = Record<string, any>;
type Answer = "drop" | "503" | "500" | "ok";
const SAVED = { ok: true, state: "active", id: "fixture-memory" };
const open: { stub: Server; child: ChildProcess }[] = [];
afterEach(async () => {
  for (const { stub, child } of open.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    stub.closeAllConnections();
    await new Promise<void>(resolve => stub.close(() => resolve()));
  }
});

/** A harness stub that answers request i with answers[i] (the last one repeats), and the proxy spawned against it. */
async function rig(answers: Answer[]) {
  const bodies: Json[] = [];
  const stub = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const answer = answers[Math.min(bodies.length, answers.length - 1)];
      bodies.push(JSON.parse(raw));
      if (answer === "drop") { req.socket.destroy(); return; }
      res.writeHead(answer === "503" ? 503 : answer === "500" ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer === "503" ? { error: "busy" } : answer === "500" ? { error: "MEMORY_RECORD_UNAVAILABLE" } : SAVED));
    });
  });
  await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
  const address = stub.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const child = await spawnBoundProxy("memory", process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./memory-proxy.ts", import.meta.url))], {
    env: { ...process.env, MURAGE_HARNESS_URL: `http://127.0.0.1:${address.port}`, MURAGE_MEMORY_TOKEN: "fixture-memory-capability" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  open.push({ stub, child });
  const pending = new Map<number, (value: Json) => void>();
  let buffered = "";
  child.stdout!.on("data", chunk => {
    buffered += chunk.toString();
    for (let end; (end = buffered.indexOf("\n")) >= 0;) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Json;
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  const call = (name: string, args: Json) => new Promise<Json | "sealed">(resolve => {
    pending.set(1, resolve);
    child.once("close", () => resolve("sealed"));
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  return { child, bodies, call };
}

const WRITES = {
  memory_save: { text: "my dog is called Biscuit", evidence: [{ quote: "my dog is called Biscuit" }], idempotencyKey: "transport-1" },
  memory_propose_correction: { id: "fixture-memory", version: 1, replacement: "my dog is called Rusty", evidence: [{ quote: "my dog is called Rusty" }], idempotencyKey: "transport-2" },
} as const;

for (const [tool, args] of Object.entries(WRITES)) {
  for (const first of ["drop", "503"] as const) {
    it(`${tool}: a ${first === "drop" ? "dropped connection" : "5xx answer"} is retried with the same key, the write lands and the turn keeps running`, async () => {
      const { child, bodies, call } = await rig([first, "ok"]);
      const reply = await call(tool, args);
      expect(boundProxyState(child).sealed, "the memory mount is not sealed (the turn is not stopped)").toBe(false);
      expect(reply, "the bot gets the harness answer").not.toBe("sealed");
      expect((reply as Json).result?.content?.[0]?.text, "the write landed on the retry").toBe(JSON.stringify(SAVED));
      expect(bodies.map(body => body.idempotencyKey), "the same write was sent again, never a new one").toEqual([args.idempotencyKey, args.idempotencyKey]);
    }, 30_000);
  }

  it(`${tool}: a harness that stays unreachable past the old retry cap still gets the write when it is back, and the turn keeps running`, async () => {
    const { child, bodies, call } = await rig(["drop", "drop", "drop", "drop", "drop", "ok"]);
    const reply = await call(tool, args);
    expect(boundProxyState(child).sealed, "the memory mount is not sealed (the turn is not stopped)").toBe(false);
    expect(reply, "the bot gets a tool answer").not.toBe("sealed");
    expect((reply as Json).result?.content?.[0]?.text, "the write landed once the harness was back").toBe(JSON.stringify(SAVED));
    expect(bodies.map(body => body.idempotencyKey), "every attempt carried the same write").toEqual(Array(6).fill(args.idempotencyKey));
  }, 45_000);
}

// MEMSWEEP-1024 F/I: a memory route that answers an error (memory_get of a forgotten memory: 500 MEMORY_RECORD_UNAVAILABLE) is a tool
// error the bot reads; it never seals the mount, so save, correction and get stay usable for the rest of the turn.
for (const [tool, args] of [["memory_get", { handles: [{ id: "fixture-forgotten", version: 1 }] }], ["memory_save", WRITES.memory_save]] as const) {
  it(`${tool}: a route error answer is a tool error and the memory tools stay mounted`, async () => {
    const { child, bodies, call } = await rig(["500"]);
    const reply = await call(tool, args);
    expect(boundProxyState(child).sealed, "the memory mount is not sealed (the turn keeps its memory tools)").toBe(false);
    expect(reply, "the bot gets a tool answer").not.toBe("sealed");
    expect([(reply as Json).result?.isError, (reply as Json).result?.content?.[0]?.text]).toEqual([true, JSON.stringify({ error: "MEMORY_RECORD_UNAVAILABLE" })]);
    expect(bodies.length, "a persistent answered error ends after a bounded number of tries").toBe(tool === "memory_save" ? 4 : 1);
  }, 30_000);
}

// Astra pass 3: transport losses never use up the answered-5xx tries (three drops then a busy 503 still retries and lands).
it("memory_save: drops before a busy answer do not use up its retries, and the write lands", async () => {
  const { child, bodies, call } = await rig(["drop", "drop", "drop", "503", "ok"]);
  const reply = await call("memory_save", WRITES.memory_save);
  expect(boundProxyState(child).sealed).toBe(false);
  expect((reply as Json).result?.content?.[0]?.text, "the write landed after the busy answer").toBe(JSON.stringify(SAVED));
  expect(bodies.length).toBe(5);
}, 45_000);
