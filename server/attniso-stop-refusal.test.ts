// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: fable-attnisoh4 owns these witnesses (W14-W16, from thrust-attniso3) and the Stop-vs-refusal product side they pin in
// server/index.ts (confirmedStopGenerations read at the lease seal; joinRefusedStop); MAIN + MC63 own the JOINT RULING STOP-VS-REFUSAL.
// Real path: the verification server, the real Stop route, the real ledger lease (its own onLedgerRefused) and the real approval
// attention scopes. Only the engine is a fixture (fake ledger driver); its interruptTurn is held, rejected or left unconfirmed per case.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { PROVIDER_STOP_UNCONFIRMED_LINE } from "./direct-late-close.ts";
import { LEDGER_REFUSAL_LINE } from "./ledger-refusal.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const line = "I stopped this turn because some of its context is no longer available.";
const api = async (method: string, path: string, body?: unknown, signal?: AbortSignal) => {
  const r = await fetch(`${fixture.info.url}${path}`, { method, signal, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};
const file = (name: string) => join(fixture.info.dataDir, name);
const attention = (thread: string) => existsSync(file("attention")) ? (JSON.parse(readFileSync(file("attention"), "utf8")) as { threadId: string; generation: string; accepting: boolean; retired: boolean }[]).filter(s => s.threadId === thread) : [];
/** The refusal's memory sources of the thread (settle: `turn:<thread>:<turn>` carrying LEDGER_REFUSAL_LINE), read from the server's database. */
const refusalSources = (thread: string): string[] => {
  const db = new DatabaseSync(file("messages.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT s.id AS id, v.payload AS payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id WHERE s.thread_id=? AND substr(s.id,1,?)=?")
      .all(thread, `turn:${thread}:`.length, `turn:${thread}:`) as { id: string; payload: string }[])
      .filter(r => String(JSON.parse(r.payload).text ?? "").includes(LEDGER_REFUSAL_LINE)).map(r => r.id);
  } finally { db.close(); }
};
const events = () => existsSync(file("receipts")) ? readFileSync(file("receipts"), "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs'), path=await import('node:path');
    const data=process.env.MURAGE_DATA_DIR, note=value=>fs.appendFileSync(path.join(data,'receipts'),JSON.stringify(value)+String.fromCharCode(10));
    const leases=new Map(), set=Map.prototype.set;
    const scopes=[];
    Map.prototype.set=function(k,v){if(v&&typeof v.onLedgerRefused==='function'&&typeof v.attach==='function')set.call(leases,v.identity.dispatchGeneration,v);
      if(v&&typeof v.threadId==='string'&&typeof v.generation==='string'&&typeof v.accepting==='boolean'&&v.waits instanceof Set&&!scopes.includes(v))scopes.push(v);return set.call(this,k,v);};
    // The real approval attention scopes (approval-attention.ts admit), observed read-only.
    // written whole and renamed into place: the test never reads a half-written snapshot
    setInterval(()=>{fs.writeFileSync(path.join(data,'attention.tmp'),JSON.stringify(scopes.map(s=>({threadId:s.threadId,generation:s.generation,accepting:s.accepting,retired:s.retired}))));fs.renameSync(path.join(data,'attention.tmp'),path.join(data,'attention'));},10).unref();
    setInterval(()=>{
      const arm=path.join(data,'refuse');if(!fs.existsSync(arm))return;
      const thread=fs.readFileSync(arm,'utf8'), lease=[...leases.values()].reverse().find(l=>l.identity.threadId===thread&&l.state==='open'&&l.providerTurnId);
      if(!lease)return;fs.unlinkSync(arm);lease.onLedgerRefused({state:'checking',reason:'not-built'});note({ev:'refused',thread});
    },10).unref();
    const { BUILT_IN_DRIVERS }=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
    const { makeLedgerDriver }=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-ledger-driver.ts")).href)});
    const driver=makeLedgerDriver(), create=driver.create;
    driver.create=async input=>{
      const instance=await create(input), adapter=instance.adapter;
      const subscribe=adapter.onEvent.bind(adapter), interrupt=adapter.interruptTurn.bind(adapter);
      // Terminal delivery is held separately from the close receipt: a confirmed Stop can precede the ledger freeze.
      adapter.onEvent=listener=>subscribe(event=>{if(event.type!=='turn.completed')listener(event);});
      adapter.interruptTurn=async (thread,turn)=>{
        note({ev:'interrupt',thread,withId:turn!==undefined});
        const mode=fs.readFileSync(path.join(data,'mode'),'utf8');
        if(turn===undefined){note({ev:'held',thread});await new Promise(resolve=>{const t=setInterval(()=>{if(fs.existsSync(path.join(data,thread+'.release'))){clearInterval(t);resolve();}},5);});}
        if(mode==='rejected')throw new Error('fixture close rejected');
        if(mode==='unconfirmed')return {closeConfirmed:false,reason:'stop-failed'};
        if(mode==='legacy')return;
        const result=await interrupt(thread,turn);note({ev:'confirmed',thread});return result;
      };
      return instance;
    };
    BUILT_IN_DRIVERS.push(driver);
    const cfgFile=path.join(data,'config.json'), cfg=JSON.parse(fs.readFileSync(cfgFile,'utf8'));
    cfg.instances.receipt={driver:'fakeLedger',environment:{FAKE_LEDGER_DUMP:path.join(data,'ledger')}};
    fs.writeFileSync(cfgFile,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30_000);
afterAll(async () => { await fixture?.close(); });

// JOINT RULING STOP-VS-REFUSAL (MAIN + MC63, 2026-11-17T20:55Z), quoted:
// "If the confirmed Stop receipt exists before the refusal freezes, the turn ends silent and the card shows the Stop.
//  If the refusal freezes while the Stop is still HELD (unconfirmed), the refusal row is shown."
// "INVARIANT: no turn ever ends with neither a refusal row nor a confirmed Stop."
// "an owner Stop is a fact only once its interrupt is CONFIRMED (its close receipt exists)."
// W14 held, W15 confirmed, W15 legacy (the Stop returned, but the engine reports no close receipt: not a fact, so the row shows),
// W16 rejected/unconfirmed. The approval attention scope the turn admitted ends closed in every
// order (no reopened wait), and the Stop route answers 409 when its close is not confirmed (ownership retained).
it.each([
  ["W14", "held"], ["W15", "confirmed"], ["W15", "legacy"], ["W16", "rejected"], ["W16", "unconfirmed"],
])("%s %s owner Stop vs refusal freeze: the ruling's row or Stop, and the turn's attention ends closed", async (_w, mode) => {
  writeFileSync(file("mode"), mode);
  const made = await api("POST", "/api/bots", { name: `Attention ${mode}`, modelSelection: { instanceId: "receipt", model: "ledger-1" } });
  expect(made.status).toBe(201);
  const bot = made.body.bot, thread = bot.threadId, sendId = `attention-stop-${mode}`;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: thread, text: "Attention fixture", sendId })).status).toBe(202);
  await expect.poll(() => existsSync(file("ledger")) && readFileSync(file("ledger"), "utf8").includes(thread)).toBe(true);
  // The real turn admitted exactly one accepting attention scope.
  await expect.poll(() => attention(thread).filter(s => s.accepting).length).toBe(1);
  const generation = attention(thread).find(s => s.accepting)!.generation;
  const stopping = api("POST", `/api/bots/${bot.id}/interrupt`, {});
  await expect.poll(() => events().some(e => e.ev === "held" && e.thread === thread)).toBe(true);
  if (mode === "confirmed" || mode === "legacy") {
    // The Stop route has answered before the refusal freezes; only "confirmed" carries the engine's close receipt.
    writeFileSync(file(thread + ".release"), "release");
    expect((await stopping).status).toBe(200);
    expect(events().some(e => e.ev === "confirmed" && e.thread === thread)).toBe(mode === "confirmed");
  }
  writeFileSync(file("refuse"), thread);
  await expect.poll(() => events().some(e => e.ev === "refused" && e.thread === thread)).toBe(true);
  const rows = async () => (await api("GET", `/api/threads/${thread}/messages?limit=200`)).body.messages.filter((m: any) => m.text === line);
  try {
    // Decided at the freeze: a HELD (or rejected/unconfirmed) Stop is not a fact yet, so the refusal row shows now.
    expect(await rows()).toHaveLength(mode === "confirmed" ? 0 : 1);
  } finally {
    if (mode !== "confirmed") writeFileSync(file(thread + ".release"), "release");
  }
  if (mode !== "confirmed") expect((await stopping).status).toBe(mode === "held" || mode === "legacy" ? 200 : 409);
  // Releasing or confirming the Stop later never rewrites the frozen decision.
  expect(await rows()).toHaveLength(mode === "confirmed" ? 0 : 1);
  const receipt = await api("GET", `/api/bots/${bot.id}/turn-state?threadId=${thread}&sendId=${sendId}`);
  if (mode === "confirmed") expect(receipt.body.terminalOutcome).toBe("stopped");
  const confirmedStop = receipt.body?.terminalOutcome === "stopped" && events().some(e => e.ev === "confirmed" && e.thread === thread);
  expect((await rows()).length > 0 || confirmedStop, "a refusal row or a confirmed Stop must explain the end").toBe(true);
  // Attention: the turn's scope is closed and nothing on the thread accepts approval waits any more.
  await expect.poll(() => attention(thread).filter(s => s.generation === generation && s.accepting).length).toBe(0);
  expect(attention(thread).filter(s => s.accepting)).toEqual([]);
  // Read once more after the refusal's close and the attention retirement settled: a late writer cannot add or drop the row.
  expect(await rows()).toHaveLength(mode === "confirmed" ? 0 : 1);
  // The memory source (fable review H2): the settle captures the refusal sentence as the turn's source, except after a confirmed Stop.
  if (mode === "confirmed") expect(refusalSources(thread), "a turn the confirmed Stop ended keeps no refusal source").toEqual([]);
  else await expect.poll(() => refusalSources(thread).length).toBe(1); // the refused turn keeps its refusal source
  // An unconfirmed close tells the owner so in the conversation (the 409's chip), exactly once; a confirmed or joined-confirmed Stop never does.
  const chips = (await api("GET", `/api/threads/${thread}/messages?limit=200`)).body.messages.filter((m: any) => m.tool?.name === PROVIDER_STOP_UNCONFIRMED_LINE);
  expect(chips).toHaveLength(mode === "rejected" || mode === "unconfirmed" ? 1 : 0);
}, 30_000);
