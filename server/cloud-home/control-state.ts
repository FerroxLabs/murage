// SPDX-License-Identifier: AGPL-3.0-or-later
// Control wire v1 (home <-> control plane). No fake literal; unknown wire fences.
// Poller: root `murage-control` (deploy/cloud-home), every 60 s, fixed HTTPS admin origin, no redirects/proxy.
// Auth: `Authorization: Bearer <machine credential>` issued by CP /v1/machines/:id/enroll (CP stores only its hash);
//   CP also requires machine generation match, machine state active, and CF-Connecting-IP in the machine's bound_ips.
//   Trust of the reply: homeKey is an ES256 envelope signed by the CP key; its public half is pinned on the home
//   (/etc/murage-home/control-plane-public-key.json) and checked here by verifiedHomeIdentity (b1b-identity.ts).
// One poll, in order, each reply requiring `wire:1`:
//   POST /v1/machines/:id/lease     {generation,holder}   -> {wire,installationId,holder,generation,expiresAt,renewAfterMs,ttlMs,skewMs}
//   POST /v1/machines/:id/heartbeat {generation}          -> {wire,accepted:true}
//   GET  /v1/machines/:id/desired                         -> {wire,homeId,generation,desiredState,engineSubscriptionGates,lease,
//                                                              executionAllowed,heartbeatFresh,heartbeatEveryMs,homeKey}
// The poller samples /usr/local/libexec/murage-clock before and after each call (boot id, NTP, mono/boot/wall must agree),
// then writes /run/murage-control/{home-generation,home-identity,state}.json (root-owned, public). Any anomaly deletes state.json.
// Deadline: conservativeDeadlineBootMs = min(send.bootMs+3_480_000, send.bootMs+(lease.expiresAt-send.wallMs)), fixed at
//   request-send time, so a slow reply never extends authority. This file (the consumer) re-checks every second.
// Gate: HomeExecutionGate opens only while createHomeControlConsumer().currentAdmission() is true, i.e. the snapshot is
//   bound to the pinned home id/generation, lease.holder is this home, executionAllowed, desiredState ready|payment_problem,
//   same boot id, clock still before the deadline and lease.expiresAt, and the signed homeKey verifies. Expiry quiesces runs.
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync } from "node:fs";
import { z } from "zod";
import { cloudHomeCopy } from "./copy.ts";
import { openProtectedRootFile, readHomePublicMetadata, verifiedHomeIdentity, type ControlPlanePublicJwk, type SignedHomeKey } from "./b1b-identity.ts";

const finite=z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const generation=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const bootId=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const sample=z.object({wallMs:finite,bootMs:finite,monoMs:finite}).strict();
const clockSchema=sample.extend({bootId,ntpSynced:z.boolean()}).strict();
const signed=z.object({algorithm:z.literal("ES256"),payload:z.string().max(4096),signature:z.string().max(128)}).strict();
const snapshotSchema=z.object({
  version:z.literal(1),homeId:id,cpGeneration:generation,requestId:id,bootId,requestSend:sample,
  conservativeDeadlineBootMs:finite,receivedAt:finite,
  desired:z.object({wire:z.literal(1),homeId:id,generation,
    desiredState:z.enum(["payment_pending","provisioning","checking","ready","payment_problem","stopped","suspended","deleting","deleted","failed"]),
    engineSubscriptionGates:z.object({claudeAgent:z.boolean(),codex:z.boolean(),grokAgent:z.boolean(),kimiAgent:z.boolean(),opencodeGo:z.boolean()}).strict(),
    lease:z.object({holder:id,generation,expiresAt:finite.int()}).strict().nullable(),
    executionAllowed:z.boolean(),heartbeatFresh:z.boolean(),heartbeatEveryMs:z.literal(60000),homeKey:signed,
  }).strict(),
}).strict();
export type ControlSnapshot=z.infer<typeof snapshotSchema>;
export type LinuxClockHealth=z.infer<typeof clockSchema>;
export interface HomeControlBinding {homeId:string;generation:number;publicOrigin:string}
export function parseControlSnapshot(input: string | unknown): ControlSnapshot {
  if(typeof input==="string" && Buffer.byteLength(input)>16_384)throw new Error(cloudHomeCopy.controlSnapshotExceedsBound);
  const result=snapshotSchema.parse(typeof input==="string"?JSON.parse(input):input);
  if(Buffer.byteLength(JSON.stringify(result))>16_384)throw new Error(cloudHomeCopy.controlSnapshotExceedsBound);
  return result;
}
export const CLOCK_HELPER_TIMEOUT_MS=1000;
/** The fixed read-only Linux helper is verified before bounded, shell-free execution. */
export function readLinuxClockHealth(): LinuxClockHealth {
  const helper="/usr/local/libexec/murage-clock",fd=openProtectedRootFile(helper);
  try {
    if(!(fstatSync(fd).mode&0o111))throw new Error(cloudHomeCopy.controlClockHelperNotExecutable);
    // A slow start of the helper is not a clock fault. On a small shared VM a brief stall
    // (seen on qa14: 100 ms was exceeded on an idle home and paused all work) must not
    // quiesce the home, so allow a second and one retry before giving up.
    const run=()=>execFileSync(helper,[],{timeout:CLOCK_HELPER_TIMEOUT_MS,maxBuffer:4096,encoding:"utf8",env:{},stdio:["ignore","pipe","ignore"]});
    let output:string;
    try {output=run();} catch {output=run();}
    return clockSchema.parse(JSON.parse(output));
  } finally {closeSync(fd);}
}
export interface HomeControlInputs {
  binding:HomeControlBinding;publicJwk:ControlPlanePublicJwk;
  readSnapshot:()=>string|unknown;readClock:()=>LinuxClockHealth;
}
/** The root publisher replaces generation, identity and state as three separate atomic
 *  files (identity before state), so a read between two replacements can see an old/new mix.
 *  A mismatch is retried a bounded number of times (the window is a few fsyncs wide) and
 *  only a persistent mismatch fails. On-disk layout is unchanged for in-place upgrades. */
export const CONTROL_SNAPSHOT_READ_ATTEMPTS=5;
export function readConsistentControlSnapshot(pinned:{homeId:string;generation:number},read:(path:string)=>string,
  attempts=CONTROL_SNAPSHOT_READ_ATTEMPTS,pause:()=>void=()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}):ControlSnapshot {
  for(let attempt=1;;attempt++){
    const state=parseControlSnapshot(read("/run/murage-control/state.json"));
    const pin=z.object({homeId:id,generation}).strict().parse(JSON.parse(read("/run/murage-control/home-generation.json")));
    const identity=signed.parse(JSON.parse(read("/run/murage-control/home-identity.json")));
    if(pin.homeId===pinned.homeId && pin.generation===pinned.generation && JSON.stringify(identity)===JSON.stringify(state.desired.homeKey))return state;
    if(attempt>=attempts)throw new Error(cloudHomeCopy.homeControlMetadataMismatch);
    pause();
  }
}
/** No authority input comes from the child environment except the independently configured origin/id. */
export function readHomeControlInputs(): HomeControlInputs {
  const pinned=z.object({homeId:id,generation}).strict().parse(JSON.parse(readHomePublicMetadata("/run/murage-control/home-generation.json")));
  if(pinned.homeId!==process.env.MURAGE_CLOUD_MACHINE_ID || !process.env.MURAGE_PUBLIC_ORIGIN)throw new Error(cloudHomeCopy.homeControlBindingUnavailable);
  const publicJwk=JSON.parse(readHomePublicMetadata("/etc/murage-home/control-plane-public-key.json")) as ControlPlanePublicJwk;
  return {binding:{...pinned,publicOrigin:process.env.MURAGE_PUBLIC_ORIGIN},publicJwk,
    readSnapshot:()=>readConsistentControlSnapshot(pinned,readHomePublicMetadata),readClock:readLinuxClockHealth};
}
export interface AuthorityAvailable {snapshot:ControlSnapshot;current:()=>boolean}
export function createHomeControlConsumer(options: HomeControlInputs & {
  onQuiesce:()=>Promise<void>|void;
  onAuthorityAvailable:(authority:AuthorityAvailable)=>Promise<void>|void;
  onIdentity:(identity:{homeKey:SignedHomeKey}|undefined)=>void;
}) {
  let closed=false,admitted=false,epoch=0,lastClock:LinuxClockHealth|undefined;
  let watermark:{bootId:string;bootMs:number}|undefined;
  let lastSnapshot:ControlSnapshot|undefined,restoring=false;
  let quiescence:Promise<void>=Promise.resolve();
  let stopFailed=false,unknownClockInvalidation=false,invalidated=false;
  const invalidate=(clock?:LinuxClockHealth,newClockFailure=false)=>{
    const firstInvalidation=!invalidated;invalidated=true;
    // Re-reading the same expired/missing snapshot is not a new event. A send
    // after the original fence must remain eligible while its response is in flight.
    if(clock && (firstInvalidation || newClockFailure))watermark={bootId:clock.bootId,bootMs:Math.max(watermark?.bootId===clock.bootId?watermark.bootMs:0,clock.bootMs)};
    else if(!clock){unknownClockInvalidation=true;if(lastClock)watermark={bootId:lastClock.bootId,bootMs:Math.max(watermark?.bootId===lastClock.bootId?watermark.bootMs:0,lastClock.bootMs)};}
    options.onIdentity(undefined);
    if(!admitted && !restoring)return;
    admitted=false;restoring=false;++epoch;
    // Callback's synchronous prefix closes persistent admission before any awaited stop.
    try {const stopped=options.onQuiesce();quiescence=Promise.resolve(stopped).then(()=>{},()=>{stopFailed=true;});}
    catch {stopFailed=true;quiescence=Promise.resolve();}
  };
  const consistentClock=(a:Pick<LinuxClockHealth,"wallMs"|"bootMs"|"monoMs">,b:LinuxClockHealth)=>
    b.bootMs>=a.bootMs && b.monoMs>=a.monoMs && Math.abs((b.bootMs-b.monoMs)-(a.bootMs-a.monoMs))<=1 && Math.abs((b.wallMs-a.wallMs)-(b.bootMs-a.bootMs))<=5000;
  const authority=():ControlSnapshot|undefined=>{
    let clock:LinuxClockHealth|undefined;
    try {
      clock=clockSchema.parse(options.readClock());
      if(unknownClockInvalidation){watermark={bootId:clock.bootId,bootMs:clock.bootMs};unknownClockInvalidation=false;}
      if(!clock.ntpSynced || (lastClock && (clock.bootId!==lastClock.bootId || !consistentClock(lastClock,clock)))){
        if(!invalidated)console.warn(`[home-control] work paused: clock check (synced=${clock.ntpSynced})`);
        invalidate(clock,true);lastClock=clock;return undefined;
      }
      lastClock=clock;
      const s=parseControlSnapshot(options.readSnapshot()),d=s.desired,l=d.lease,b=options.binding;
      if(s.homeId!==b.homeId || s.cpGeneration!==b.generation || d.homeId!==b.homeId || d.generation!==b.generation || !l || l.holder!==b.homeId || l.generation!==b.generation
        || !d.executionAllowed || !["ready","payment_problem"].includes(d.desiredState) || s.bootId!==clock.bootId
        || !consistentClock(s.requestSend,clock) || s.receivedAt<s.requestSend.wallMs || s.receivedAt>clock.wallMs
        || s.conservativeDeadlineBootMs<=s.requestSend.bootMs || s.conservativeDeadlineBootMs>s.requestSend.bootMs+3_480_000
        || clock.bootMs>=s.conservativeDeadlineBootMs || clock.wallMs>=l.expiresAt
        || (watermark && (s.bootId!==watermark.bootId || s.requestSend.bootMs<=watermark.bootMs)))throw new Error(cloudHomeCopy.homeControlLeaseUnavailable);
      if(lastSnapshot && s.bootId===lastSnapshot.bootId && (s.requestSend.bootMs<lastSnapshot.requestSend.bootMs || (s.requestId===lastSnapshot.requestId && JSON.stringify(s)!==JSON.stringify(lastSnapshot))))throw new Error(cloudHomeCopy.homeControlRenewalRegressed);
      const identity=verifiedHomeIdentity(d.homeKey,options.publicJwk,b.homeId,b.generation,b.publicOrigin,clock.wallMs);
      lastSnapshot=s;invalidated=false;options.onIdentity(identity);return s;
    } catch (error) {
      // One line per loss, never per poll: a paused home with no reason in its log cannot be diagnosed.
      if(!invalidated)console.warn(`[home-control] work paused: ${error instanceof Error ? error.message.slice(0,160) : typeof error}`);
      invalidate(clock);if(clock)lastClock=clock;return undefined;
    }
  };
  const check=()=>{
    if(closed)return false;
    const s=authority();if(!s || stopFailed)return false;
    if(!admitted && !restoring){
      restoring=true;const generation=epoch;
      void (async()=>{
        await quiescence;
        const current=()=>!closed && generation===epoch && !stopFailed && Boolean(authority());
        if(!current())return;
        await options.onAuthorityAvailable({snapshot:s,current});
        if(current()){admitted=true;restoring=false;}
      })().catch(()=>{if(generation===epoch)invalidate(lastClock);});
    }
    return admitted;
  };
  const timer=setInterval(check,1000);timer.unref();check();
  return {
    currentAdmission:check,
    currentAuthority:()=>!closed && !stopFailed && Boolean(authority()),
    identity:()=>{const s=authority();return s?{homeKey:s.desired.homeKey}:undefined;},
    close:()=>{if(closed)return;invalidate();closed=true;clearInterval(timer);},
  };
}
