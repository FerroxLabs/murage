// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The other routes that create a bot after a wait: pairing an external browser client, importing from Hermes, and a lead's create_bot. The
// request gate runs when the request arrives. A writer hold that starts during the route's wait would put the write on the hold's 50 ms
// budget, and the owner would get "Busy for a moment". Each route waits the hold out instead (create-bot-writer-hold-api.test.ts has POST /api/bots).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const databaseUrl = JSON.stringify(new URL("./database.ts", import.meta.url).href);
/** In the server's own process: a file named `hold-now` starts a real hold on a real lock, as an index build does, and a declared browser with one profile. */
const INSTRUMENTATION = `
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
    setTimeout(() => { writer.exec("COMMIT"); writer.close(); holdWritersForIndexBuild(false); }, 2000);
  }, 5).unref();
  const { registerHooks } = await import("node:module");
  registerHooks({ load(url, context, next) {
    if (url.endsWith("/browser-extension-registration.mjs")) return { format: "module", shortCircuit: true, source: "export async function connectOwnerBrowser(input){if(!input.ownerConfirmed)throw Error('consent');return {status:'installed',connected:false}};export async function removeOwnerBrowser(){return {status:'removed'}}" };
    if (!url.endsWith("/browser-extension-broker.ts")) return next(url, context);
    return { format: "module", shortCircuit: true, source: "export async function startBrowserExtensionBroker(){return {configPath:'/fixture-only/no-native-registration',profiles:()=>[{version:1,type:'hello',profileId:'fixture_profile',browser:'chromium',extensionVersion:'1',capabilities:['scoped_cdp','durable_stop','explicit_share','manual_pause','unexpected_input_pause','engine_cdp_v1','ordered_requests_v1']}],close:async()=>{},request:async()=>{throw Error('no browser in this fixture')}}}" };
  } });
`;

let fixture: VerificationServer;
let owner: Record<string, string>;
const dataFile = (name: string) => join(fixture.info.dataDir, name);
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(fixture.info.url + path, { method, headers: { ...owner, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 2000 && !ready(); i++) await new Promise(done => setTimeout(done, 5));
  expect(ready()).toBe(true);
};
/** The head goes now and passes the request gate; the body, which the route waits for, goes once the hold is in force. */
function postAcrossHold(path: string, json: unknown, headers: Record<string, string>, method: "POST" | "PATCH" = "POST") {
  rmSync(dataFile("hold-held"), { force: true });
  const body = JSON.stringify(json);
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const post = request(new URL(path, fixture.info.url), { method, headers: { ...headers, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }, response => {
      let text = "";
      response.on("data", chunk => { text += String(chunk); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    });
    post.on("error", reject);
    post.flushHeaders();
    setTimeout(() => {
      writeFileSync(dataFile("hold-now"), "1");
      void until(() => existsSync(dataFile("hold-held"))).then(() => post.end(body), reject);
    }, 150);
  });
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: INSTRUMENTATION });
  const hermes = join(fixture.info.dataDir, ".hermes");
  mkdirSync(join(hermes, "profiles", "fred"), { recursive: true });
  writeFileSync(join(hermes, "config.yaml"), "model:\n  default: base-model\n  provider: custom\n");
  writeFileSync(join(hermes, "profiles", "fred", "config.yaml"), "model:\n  default: fred-model\n  provider: custom\n");
  await fixture.restart();
  const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
}, 150_000);
afterAll(async () => { await fixture?.close(); });

it("a browser client paired just before a writer hold begins is created once the hold ends", { timeout: 60_000 }, async () => {
  expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
  const existing = (await api("GET", "/api/bots")).body.bots[0];
  expect((await api("POST", `/api/bots/${existing.id}/browser-extension`, { action: "connect" })).status).toBe(200);
  expect((await api("POST", "/api/browser-extension/clients", { action: "enabled", enabled: true })).status).toBe(200);
  // EP B2 / S134 4.6: confirm the current destination before pairing.
  const preview = await api("POST", "/api/browser-extension/clients", { action: "preview", label: "Paired fixture", profileId: "fixture_profile" });
  expect(preview.status).toBe(200);
  const paired = await postAcrossHold("/api/browser-extension/clients", { action: "pair", label: "Paired fixture", profileId: "fixture_profile", disclosureKey: preview.body.disclosure.disclosureKey }, owner);
  expect(paired.status, paired.text).toBe(201);
  expect((await api("GET", "/api/bots")).body.bots.filter((bot: { name: string }) => bot.name === "Paired fixture")).toHaveLength(1);
});

it("a Hermes profile imported just before a writer hold begins is created once the hold ends", { timeout: 60_000 }, async () => {
  const imported = await postAcrossHold("/api/hermes/profiles/import", { profiles: ["fred"] }, owner);
  expect(imported.status, imported.text).toBe(200);
  expect(JSON.parse(imported.text).created).toHaveLength(1);
  expect((await api("GET", "/api/bots")).body.bots.filter((bot: { name: string }) => bot.name === "fred")).toHaveLength(1);
});

it("a lead's create_bot asked for just before a writer hold begins is created once the hold ends", { timeout: 120_000 }, async () => {
  const lead = (await api("POST", "/api/bots", { name: "Hold Lead" })).body.bot as { id: string; threadId: string; modelSelection: unknown };
  expect((await api("PATCH", `/api/bots/${lead.id}`, { section: "Hold Team", chiefOfStaff: true })).status).toBe(200);
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "__fixture_hold_authority__", threadId: lead.threadId })).status).toBe(202);
  let turn: { mcpConfig: { mcpServers: { agents: { env: Record<string, string> } } } } | undefined;
  await expect.poll(() => {
    try { turn = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); return true; } catch { return false; }
  }, { timeout: 45_000 }).toBe(true);
  const token = turn!.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN;
  const made = await postAcrossHold("/api/internal/create-bot", { fromBotId: lead.id, fromThreadId: lead.threadId, name: "Held specialist", role: "Specialist", instructions: "Serve the client." }, { authorization: `Bearer ${token}` });
  expect(made.status, made.text).toBe(201);
  expect((await api("GET", "/api/bots")).body.bots.filter((bot: { name: string }) => bot.name === "Held specialist")).toHaveLength(1);
});

it("a reviewed legacy browser PATCH without baseRevision waits out a writer hold", { timeout: 60_000 }, async () => {
  const created = await api("POST", "/api/bots", {name:"Legacy held choice"});
  expect(created.status).toBe(201);
  const path = `/api/bots/${created.body.bot.id}`;
  const preview = await api("GET", path + "/browser-choice/preview?mode=builtin&profile=guest");
  expect(preview.status).toBe(200);
  const changed = await postAcrossHold(path, {browserProfile:"guest", disclosureKey:preview.body.disclosure.disclosureKey}, owner, "PATCH");
  expect(changed.status, changed.text).toBe(200);
  expect(JSON.parse(changed.text).bot).toMatchObject({browserMode:"builtin",browserProfile:"guest",selectionRevision:preview.body.baseRevision+1});
});
