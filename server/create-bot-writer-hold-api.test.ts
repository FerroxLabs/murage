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
/** In the server's own process: a file named `hold-now` starts a real hold on a real lock, as an index build does. */
const HOLD_ON_SIGNAL = `
  const { holdWritersForIndexBuild, writersHeldForIndexBuild } = await import(${databaseUrl});
  const { DatabaseSync } = await import("node:sqlite");
  const { existsSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const signal = join(process.env.MURAGE_DATA_DIR, "hold-now"), held = join(process.env.MURAGE_DATA_DIR, "hold-held");
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
    setTimeout(() => { writer.exec("COMMIT"); writer.close(); holdWritersForIndexBuild(false); }, 1200);
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
