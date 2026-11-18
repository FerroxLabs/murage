// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Child of server/team-identities-switch.test.ts (ACCEPTANCE.md E4). Usage: team-identities-switch-child.ts <prepare|refused|retry> <ballast file>
//  prepare: a normal start builds a bot and the test then adds a sharing entry for a team that no longer exists (a ghost), in the roster file.
//  refused: a NORMAL start check, then the disk is taken to 0 free, then the real boot step runs (index.ts: bootStep("teams.reconcileIdentities", ...)):
//           the reconcile drops the ghost in memory and its roster save fails with the OS's ENOSPC.
//  retry:   a fresh start with the space back runs the same step and the roster has the change.
const [scenario = "", ballast = ""] = process.argv.slice(2);
const dataDir = process.env.MURAGE_DATA_DIR;
if (!dataDir || !process.env.TEAM_SWITCH_CHILD) { process.stderr.write("refusing: not started by the team switch test\n"); process.exit(2); }
const { mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
if(scenario==="refused") {
  const {registerHooks}=await import("node:module");
  registerHooks({load(url,context,next) {
    const result=next(url,context);
    if(!url.endsWith("/server/atomic.ts"))return result;
    const text=String(result.source),needle="  writeFileAtomicInner(path, data, options);";
    if(text.split(needle).length!==2)throw new Error("fixture atomic boundary missing");
    return {...result,source:text.replace(needle,'  Reflect.get(globalThis,"fixtureRosterFill")?.(path);\n'+needle)};
  }});
}
const { closeDatabase, database } = await import("../database.ts");
const { flushCoalesced } = await import("../atomic.ts");
const { isReadOnly, readOnlyState, skippedAtStart, startMode, bootStep } = await import("../read-only-start.ts");
const { reconcileTeamIdentities } = await import("../team-lifecycle.ts");
const { Store } = await import("../store.ts");
const { fillTo } = await import("./strict-fs.ts");
const GHOST = "11111111-1111-4111-8111-111111111111";
const botsFile = join(dataDir, "bots.json");
const sharedWith = () => { const parsed = JSON.parse(readFileSync(botsFile, "utf8")) as unknown; const list = (Array.isArray(parsed) ? parsed : (parsed as { bots: unknown[] }).bots) as Array<{ sharedWith?: { teams: unknown[] } }>; return list[0]?.sharedWith?.teams ?? null; };

mkdirSync(dataDir, { recursive: true });
const out: Record<string, unknown> = { scenario };
if (scenario === "prepare") {
  writeFileSync(join(dataDir,"config.json"),JSON.stringify({instances:{}}));
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  store.createBot({ name: "Painter" });
  flushCoalesced();
  database(); closeDatabase();
  const parsed = JSON.parse(readFileSync(botsFile, "utf8")) as unknown;
  const list = (Array.isArray(parsed) ? parsed : (parsed as { bots: Array<Record<string, unknown>> }).bots) as Array<Record<string, unknown>>;
  list[0]!.sharedWith = { mode: "list", teams: [{ id: GHOST, name: "Gone" }] };
  writeFileSync(botsFile, JSON.stringify(parsed));
  out.before = sharedWith();
} else {
  out.startMode = startMode(dataDir);
  database();
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  if (scenario === "refused") {
    const patch=store.patchBot;
    store.patchBot=function(...args) {
      try { return patch.apply(this,args); }
      catch(error) {
        out.writeError={code:(error as NodeJS.ErrnoException).code,atomic:error instanceof Error && /writeFileAtomic/.test(error.stack??"")};
        throw error;
      }
    };
    let armed=true;
    Reflect.set(globalThis,"fixtureRosterFill",(path:string)=>{
      if(armed && path===botsFile){armed=false;fillTo(ballast,0);}
    });
  }
  const notes = bootStep("teams.reconcileIdentities", () => reconcileTeamIdentities(store), [] as string[]);
  Object.assign(out, { notes: notes.length, readOnly: isReadOnly(), reason: readOnlyState()?.reason ?? null, skipped: [...skippedAtStart] });
  if (scenario === "refused") rmSync(ballast, { force: true });
  out.sharedWith = sharedWith();
  out.memoryTeams=store.bots[0]?.sharedWith?.teams;
  if(scenario==="refused") {
    const [{stopDataWriters},{stopWalMaintenance},{stopSearchIndex}]=await Promise.all([import("../data-writers.ts"),import("../wal-maintenance.ts"),import("../message-search-index.ts")]);
    // The real server has its listener alive during shutdown; this fixture has not opened it yet.
    const keepAlive=setInterval(()=>{},1000);
    try { if(!await stopDataWriters({closeDatabase,stopEngineHistory:async()=>true,stopWalMaintenance,stopSearchIndex}))throw new Error("fixture storage did not close"); }
    finally { clearInterval(keepAlive); }
    const {freePortBlock}=await import("./ports.ts");
    const port=await freePortBlock([0,1],19811,200);
    process.env.MURAGE_PORT=String(port);process.env.MURAGE_WEBHOOK_PORT=String(port+1);
    await import("../index.ts");
    const response=await fetch(`http://127.0.0.1:${port}/api/health`);
    out.serving=response.ok;out.healthDiskMode=((await response.json()) as {diskLow?:{mode?:string}}).diskLow?.mode;
  }
  try { closeDatabase(); } catch { /* the handle may be mid-failure */ }
}
process.stdout.write(`TSRESULT ${JSON.stringify(out)}\n`);
process.exit(0);
