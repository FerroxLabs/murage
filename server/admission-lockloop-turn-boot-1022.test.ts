// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: admission refresh backoff + miss lines (io-budget.ts) and this witness = q1022-lockloop-opus; ledger lock (admission-shared.ts) and
// its other holder (the checkpointer worker) = scperf-p1; the turn.started handler (index.ts foldRuntimeEvent) = MAIN train.
// IDLECPU-1022 cause 3, W-TURN on the real path: a booted verification server runs a real fake-engine turn, so ioBudget.noteForegroundActivity
// is called by the turn.started case of foldRuntimeEvent (server/index.ts). Inside the server child a commit storm holds the real ledger word
// (150 commits a minute, 120 ms copy holds, the background loops' idleQuiet every 100 ms), then the turn begins inside a held window.
// The fixture only plants the lock's other holder and observes; the miss, the backoff, the reset and the republish are the server's own.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

const IO_BUDGET = JSON.stringify(pathToFileURL(join(process.cwd(), "server/io-budget.ts")).href);
const INDEX = JSON.stringify(join(process.cwd(), "server/index.ts"));
const STORM = `
const {ioBudget}=await import(${IO_BUDGET});
const lockloopFs=await import('node:fs');
const indexLines=lockloopFs.readFileSync(${INDEX},'utf8').split('\\n');
const dir=process.env.MURAGE_DATA_DIR,FOREIGN=(7n<<32n)|1n;
let slots=null,held=false,mode='off',turn=null,t0=0,lastQuiet=0,stormMisses0=0;
const S=()=>slots??=new BigInt64Array(ioBudget.checkpointAdmissionBuffer(false));
const hold=()=>{if(!held&&Atomics.compareExchange(S(),0,0n,FOREIGN)===0n)held=true;};
const release=()=>{if(held){Atomics.compareExchange(S(),0,FOREIGN,0n);held=false;}};
const tick=setInterval(()=>{
  if(mode==='off'){if(lockloopFs.existsSync(dir+'/lockloop-storm')){mode='storm';t0=Date.now();stormMisses0=ioBudget.admissionHealth().lockTimeouts;}return;}
  if(mode!=='storm')return;
  if((Date.now()-t0)%400<120)hold();else release();
  if(Date.now()-lastQuiet>=100){lastQuiet=Date.now();ioBudget.idleQuiet();}
},5);
tick.unref();
const real=ioBudget.noteForegroundActivity.bind(ioBudget);
ioBudget.noteForegroundActivity=function(){
  // only the call made by the turn.started case of foldRuntimeEvent: its caller frame is the server/index.ts line right after case "turn.started"
  // (turn.completed and the owner-action HTTP path call the same method from other lines)
  const site=/server\\/index\\.ts:(\\d+):\\d+/.exec(String(new Error().stack));
  if(mode!=='storm'||turn||!site||!(indexLines[Number(site[1])-2]??'').includes('case "turn.started":'))return real();
  mode='turn';hold(); // the turn begins inside a held window; the storm's background callers stop
  const misses=ioBudget.admissionHealth().lockTimeouts,at=Date.now();
  real();
  turn={site:indexLines[Number(site[1])-1].trim(),stormMisses:misses-stormMisses0,missed:ioBudget.admissionHealth().lockTimeouts-misses,verdictAfterMiss:String(S()[7]),publishedMs:-1,armedBackoffMs:Reflect.get(ioBudget,'admissionDelay'),refreshArmed:ioBudget.admissionRefresh().armed};
  setTimeout(release,150);
  const poll=setInterval(()=>{
    if(turn.publishedMs<0&&!held&&S()[7]===0n)turn.publishedMs=Date.now()-at;
    if(Date.now()-at>=4000){clearInterval(poll);lockloopFs.writeFileSync(dir+'/lockloop-turn.json',JSON.stringify(turn));}
  },2);
};
`;

it("W-TURN-BOOT a real turn.started inside a held ledger window after a commit storm: the miss is no ERROR and the backed-off refresh republishes ACTIVE within 1 s", async () => {
  const session = await launchVerificationServer(process.env, undefined, { turnLog: { replies: ["fixture reply"] }, instrumentationSource: STORM });
  const env = { MURAGE_URL: session.info.url };
  const call = async (args: string[]) => await runControlMurage([...args, "--url", session.info.url], { env }) as any;
  try {
    const created = await call(["new-bot", "--name", "Lockloop probe"]), id = created.bot.id;
    const logStart = readFileSync(session.info.logPath, "utf8").length;
    writeFileSync(join(session.info.dataDir, "lockloop-storm"), "");
    await new Promise(resolve => setTimeout(resolve, 3_000)); // 7 commits of storm: misses, each reset by a section that took the lock
    await call(["send", "--bot", id, "--text", "Run the deterministic fixture reply"]);
    expect((await call(["wait", "--bot", id, "--timeout", "30"])).status, "setup: the turn settled").toBe("settled");
    const out = join(session.info.dataDir, "lockloop-turn.json");
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(existsSync(out), "turn.started (the case in index.ts foldRuntimeEvent) called ioBudget.noteForegroundActivity during the storm").toBe(true);
    const turn = JSON.parse(readFileSync(out, "utf8")) as { site: string; stormMisses: number; missed: number; verdictAfterMiss: string; publishedMs: number; armedBackoffMs: number; refreshArmed: boolean };
    const errors = readFileSync(session.info.logPath, "utf8").slice(logStart).split("\n").filter(line => /\bERROR AdmissionLockTimeout\b/.test(line));
    console.log(`[LOCKLOOP-MEASURE] boot turn: ${JSON.stringify(turn)} errorLines ${errors.length}`);
    expect(turn.stormMisses, "setup: the storm's held windows made the background sections miss before the turn").toBeGreaterThanOrEqual(4);
    expect(turn.missed, "setup: turn.started's own admission section missed the held ledger lock").toBeGreaterThanOrEqual(1);
    expect(turn.verdictAfterMiss, "setup: the miss failed closed (ACTIVE not yet published)").toBe("1");
    expect(errors, "a ledger-lock miss during the storm and the turn is a rate-limited WARN, never an ERROR line").toEqual([]);
    expect(turn.publishedMs, "the turn's ACTIVE verdict was published once the hold ended").toBeGreaterThan(0);
    expect(turn.publishedMs, "the turn's ACTIVE verdict was published within 1 s of the turn beginning inside a held window").toBeLessThanOrEqual(1_000);
    // the storm's misses were each reset by a section that took the lock, so the refresh the turn's miss armed (read from the server's own
    // IoBudget right after the real handler returned) waits the first backoff step, never a backoff grown to 2 s by already-resolved misses
    expect(turn.refreshArmed, "the turn's miss left the admission refresh armed").toBe(true);
    expect(turn.armedBackoffMs, "the refresh re-armed by the turn's miss waits at most 1 s, not a 2 s backoff grown by resolved misses").toBeLessThanOrEqual(1_000);
  } finally { await session.close(); }
}, 120_000);
