// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.24 q1024-linuxmem witness (MAIN-RULING memory, LINUXMEM-1023; reviews of a8e4640ad0 / d7d7926ea7): a lost transport on the bot's
// own memory_save never stops the owner's turn and never drops the save. One row per site the old proxy sealed the mount on: an
// answer slower than the old 65 s deadline, an answer that is not JSON, a JSON answer that is not an object, an answer cut off
// mid-body, a release door that cannot be reached for the answer's reservation, a 500 on every attempt, and a turn credential that
// cannot be read. Every row calls memory_save over stdio MCP on the real spawned memory proxy
// (server/drivers/memory-proxy.ts handleMessage), bound to the turn release, against a real HTTP stub of the harness route.
import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { spawnBoundProxy, boundProxyState } from "../testing/bound-proxy-fixture.ts";

type Json = Record<string, any>;
/** What the stub does with one request: a JSON body with a status, a raw body, or a wait before the saved answer. */
type Answer = { status?: number; raw?: string; waitMs?: number; cut?: true };
const SAVED = { ok: true, state: "active", id: "fixture-memory" };
const OK: Answer = {};
const SAVE = { text: "the boat is moored at pier four", evidence: [{ quote: "the boat is moored at pier four" }], idempotencyKey: "linuxmem-transport-1" };
const open: { stub: Server; child: ChildProcess }[] = [];
afterEach(async () => {
  for (const { stub, child } of open.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    stub.closeAllConnections();
    await new Promise<void>(resolve => stub.close(() => resolve()));
  }
});

/** A harness stub answering request i with answers[i] (the last one repeats), and the real memory proxy spawned against it. */
async function rig(answers: Answer[], credential = true, dropUpstreams = 0) {
  const bodies: Json[] = [];
  const stub = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const answer = answers[Math.min(bodies.length, answers.length - 1)];
      bodies.push(JSON.parse(raw));
      setTimeout(() => {
        if (res.destroyed) return;
        if (answer.cut) { res.writeHead(200, { "content-type": "application/json" }); res.write('{"ok":tr'); setTimeout(() => req.socket.destroy(), 50); return; }
        res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
        res.end(answer.raw ?? JSON.stringify((answer.status ?? 200) >= 500 ? { error: "MEMORY_EVIDENCE_UNAVAILABLE" } : SAVED));
      }, answer.waitMs ?? 0);
    });
  });
  await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
  const address = stub.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const env: NodeJS.ProcessEnv = { ...process.env, MURAGE_HARNESS_URL: `http://127.0.0.1:${address.port}` };
  delete env.MURAGE_MEMORY_TOKEN;
  if (credential) env.MURAGE_MEMORY_TOKEN = "fixture-memory-capability";
  const child = await spawnBoundProxy("memory", process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./memory-proxy.ts", import.meta.url))], { env, stdio: ["pipe", "pipe", "pipe"], dropUpstreams });
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
  let next = 0;
  const call = (name: string, args: Json) => new Promise<Json | "closed">(resolve => {
    const id = ++next;
    pending.set(id, resolve);
    child.once("close", () => resolve("closed"));
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  return { child, bodies, call };
}
const text = (reply: Json | "closed") => reply === "closed" ? "closed" : reply.result?.content?.[0]?.text;
const failed = (reply: Json | "closed") => reply === "closed" ? "closed" : reply.result?.isError === true;

// The save lands: the mount is open, the bot reads the saved answer, and the stub saw exactly `sent` requests, all the same save.
const LANDS: [site: string, answers: Answer[], sent: number, dropUpstreams?: number][] = [
  ["an answer slower than 65 s is waited for, not sent again", [{ waitMs: 66_500 }, OK], 1],
  ["an answer that is not JSON is retried", [{ raw: "upstream said no" }, OK], 2],
  ["an answer cut off mid-body is retried", [{ cut: true }, OK], 2],
  // the door client itself tries a dropped connection once more, so two drops are one lost reservation
  ["a release door that cannot be reached for the answer's reservation is retried", [OK], 2, 2],
];
for (const [site, answers, sent, dropUpstreams] of LANDS) {
  it(`memory_save: ${site}; the save lands and the turn keeps running`, async () => {
    const { child, bodies, call } = await rig(answers, true, dropUpstreams);
    const reply = await call("memory_save", SAVE);
    expect({ sealed: boundProxyState(child).sealed, answer: text(reply) }, "the mount is open (the turn is not stopped) and the bot reads the saved answer").toEqual({ sealed: false, answer: JSON.stringify(SAVED) });
    expect(bodies.map(body => body.idempotencyKey), "the same save, this many times").toEqual(Array(sent).fill(SAVE.idempotencyKey));
  }, 100_000);
}

// The harness answered, and the answer is a failure: the bot reads a plain tool error, the mount stays open, and the next save in the
// same turn lands. `sent` is how many times the failed save was sent before the bot was told.
const TOLD: [site: string, answer: Answer, sent: number, says: string][] = [
  ["a 500 on every attempt", { status: 500 }, 4, "MEMORY_EVIDENCE_UNAVAILABLE"],
  ["a JSON answer that is not an object", { raw: "null" }, 1, "MEMORY_UNAVAILABLE"],
];
for (const [site, answer, sent, says] of TOLD) {
  it(`memory_save: ${site} is a plain tool error, the turn keeps running and the next save in the same turn lands`, async () => {
    const { child, bodies, call } = await rig([...Array(sent).fill(answer), OK]);
    const first = await call("memory_save", SAVE);
    expect({ sealed: boundProxyState(child).sealed, failed: failed(first), says: String(text(first)).includes(says) }, "the mount is open and the bot is told the save did not land, with the reason").toEqual({ sealed: false, failed: true, says: true });
    const again = await call("memory_save", SAVE);
    expect({ sealed: boundProxyState(child).sealed, answer: text(again), keys: bodies.map(body => body.idempotencyKey) }, "the repeated save lands in the same turn").toEqual({ sealed: false, answer: JSON.stringify(SAVED), keys: Array(sent + 1).fill(SAVE.idempotencyKey) });
  }, 60_000);
}

it("memory_save: a turn credential that cannot be read is a plain tool error and nothing is sent; the turn keeps running", async () => {
  const { child, bodies, call } = await rig([OK], false);
  const reply = await call("memory_save", SAVE);
  expect({ sealed: boundProxyState(child).sealed, failed: failed(reply), sent: bodies.length }, "the mount is open, the bot is told nothing was saved, nothing left the proxy").toEqual({ sealed: false, failed: true, sent: 0 });
  expect(text(reply), "the bot is told plainly that nothing was saved").toContain("nothing was saved");
}, 30_000);

it("control: a read with no turn credential still seals the mount (unchanged)", async () => {
  const { child, bodies, call } = await rig([OK], false);
  const reply = await call("memory_search", { query: "pier" });
  expect({ sealed: boundProxyState(child).sealed, answered: reply !== "closed" && reply.result !== undefined, sent: bodies.length }).toEqual({ sealed: true, answered: false, sent: 0 });
}, 30_000);
