// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Creating a bot while a writer hold begins (ledger HUMAN-SETUP-FLAKE). The request gate runs when the request arrives, and the
// route then waits for its body and the engine list. A hold that starts in that gap (an index build just after start) put the
// write on the hold's 50 ms budget, so the owner got "Busy for a moment" at once. The route waits the hold out instead.
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const databaseUrl = JSON.stringify(new URL("./database.ts", import.meta.url).href);
const dbBusyUrl = JSON.stringify(new URL("./db-busy.ts", import.meta.url).href);
/** In the server's own process: a file named `hold-now` starts a real hold on a real lock, as an index build does. */
const HOLD_ON_SIGNAL = `
  const { holdWritersForIndexBuild, writersHeldForIndexBuild } = await import(${databaseUrl});
  const { waitingAtWriterGate } = await import(${dbBusyUrl});
  const { DatabaseSync } = await import("node:sqlite");
  const { existsSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { ServerResponse } = await import("node:http");
  const signal = join(process.env.MURAGE_DATA_DIR, "hold-now"), held = join(process.env.MURAGE_DATA_DIR, "hold-held");
  const file = name => join(process.env.MURAGE_DATA_DIR, name);
  // Tells a test the moment the import route waits at its gate after the scan, and the moment the server has heard its caller leave.
  setInterval(() => { if (waitingAtWriterGate("team-import") && !existsSync(file("gate-waiting"))) writeFileSync(file("gate-waiting"), "1"); }, 2).unref();
  const emit = ServerResponse.prototype.emit;
  ServerResponse.prototype.emit = function (event, ...rest) {
    if (event === "close" && !this.writableEnded && this.req?.url?.startsWith("/api/teams/import")) writeFileSync(file("caller-left"), "1");
    return emit.call(this, event, ...rest);
  };
  let heldAt = Date.now();
  setInterval(() => {
    // The server's own index build runs just after start and shares this one hold: let it finish first.
    if (writersHeldForIndexBuild()) heldAt = Date.now();
    if (!existsSync(signal) || Date.now() - heldAt < 1500) return;
    rmSync(signal);
    holdWritersForIndexBuild(true);
    const writer = new DatabaseSync(join(process.env.MURAGE_DATA_DIR, "messages.db"));
    writer.exec("PRAGMA busy_timeout=10000; BEGIN IMMEDIATE");
    writeFileSync(held, "1");
    // Normally a fixed hold; with hold-until-release the test ends it, once what it is proving has happened.
    const manual = existsSync(file("hold-until-release")), began = Date.now();
    const end = () => { writer.exec("COMMIT"); writer.close(); holdWritersForIndexBuild(false); writeFileSync(file("hold-ended"), "1"); };
    const check = setInterval(() => {
      if (!manual ? Date.now() - began < 1200 : !existsSync(file("hold-release")) && Date.now() - began < 30_000) return;
      clearInterval(check);
      end();
    }, 5);
  }, 5).unref();
`;

let fixture: VerificationServer;
let headers: Record<string, string>;
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: HOLD_ON_SIGNAL });
  const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
}, 150_000);
afterAll(async () => { await fixture?.close(); });

const until = async (ready: () => boolean) => {
  for (let i = 0; i < 2000 && !ready(); i++) await new Promise(done => setTimeout(done, 5));
  expect(ready()).toBe(true);
};

it("a bot asked for just before a writer hold begins is created once the hold ends", { timeout: 60_000 }, async () => {
  const { existsSync } = await import("node:fs");
  const url = new URL("/api/bots", fixture.info.url);
  const body = JSON.stringify({ name: "Held fixture" });
  const answered = new Promise<number>((resolve, reject) => {
    const post = request(url, { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    post.on("error", reject);
    // The head goes now and passes the request gate; the body, which the route waits for, goes once the hold is in force.
    post.flushHeaders();
    setTimeout(() => {
      writeFileSync(join(fixture.info.dataDir, "hold-now"), "1");
      void until(() => existsSync(join(fixture.info.dataDir, "hold-held"))).then(() => post.end(body), reject);
    }, 150);
  });
  expect(await answered).toBe(201);
  const { bots } = await (await fetch(`${fixture.info.url}/api/bots`, { headers })).json() as { bots: { name: string }[] };
  expect(bots.filter(bot => bot.name === "Held fixture")).toHaveLength(1);
});

it("a team imported just before a writer hold begins is created once the hold ends", { timeout: 60_000 }, async () => {
  const { existsSync, rmSync } = await import("node:fs");
  rmSync(join(fixture.info.dataDir, "hold-held"), { force: true });
  const url = new URL("/api/teams/import", fixture.info.url);
  const body = JSON.stringify({ format: "murage.team", version: 2, team: { name: "Field Team", members: [{ key: "mira", name: "Imported fixture", title: "Lead", description: "Keeps the crew on track.", appearance: { color: "purple" } }] } });
  const answered = new Promise<number>((resolve, reject) => {
    const post = request(url, { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    post.on("error", reject);
    post.flushHeaders();
    setTimeout(() => {
      writeFileSync(join(fixture.info.dataDir, "hold-now"), "1");
      void until(() => existsSync(join(fixture.info.dataDir, "hold-held"))).then(() => post.end(body), reject);
    }, 150);
  });
  expect(await answered).toBe(201);
  const { bots } = await (await fetch(`${fixture.info.url}/api/bots`, { headers })).json() as { bots: { name: string }[] };
  expect(bots.filter(bot => bot.name === "Imported fixture")).toHaveLength(1);
});

it("a team import whose caller leaves during the hold creates nothing", { timeout: 60_000 }, async () => {
  const { existsSync, rmSync } = await import("node:fs");
  rmSync(join(fixture.info.dataDir, "hold-held"), { force: true });
  const url = new URL("/api/teams/import", fixture.info.url);
  const body = JSON.stringify({ format: "murage.team", version: 2, team: { name: "Field Team", members: [{ key: "gone", name: "Left fixture", title: "Lead", description: "Keeps the crew on track.", appearance: { color: "purple" } }] } });
  const dir = fixture.info.dataDir, seen = (name: string) => () => existsSync(join(dir, name));
  rmSync(join(dir, "gate-waiting"), { force: true });
  rmSync(join(dir, "hold-ended"), { force: true });
  writeFileSync(join(dir, "hold-until-release"), "1");
  let answered = false;
  const post = request(url, { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } }, response => { answered = true; response.resume(); });
  post.on("error", () => undefined);
  post.flushHeaders();
  await new Promise(done => setTimeout(done, 150));
  writeFileSync(join(dir, "hold-now"), "1");
  await until(seen("hold-held"));
  post.end(body);
  // The route has read the body and finished its scan: it is waiting at the gate, unanswered, when the caller leaves.
  await until(seen("gate-waiting"));
  expect(answered).toBe(false);
  post.destroy();
  await until(seen("caller-left"));
  writeFileSync(join(dir, "hold-release"), "1");
  await until(seen("hold-ended"));
  // A write after the gate would be done by the time this read is answered: the route has no await left before it.
  const { bots } = await (await fetch(`${fixture.info.url}/api/bots`, { headers })).json() as { bots: { name: string }[] };
  expect(bots.filter(bot => bot.name === "Left fixture")).toEqual([]);
  rmSync(join(dir, "hold-until-release"), { force: true });
});
