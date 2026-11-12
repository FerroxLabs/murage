import { assertSignalDowngradeAuthority } from './park-downgrade-authority.ts';
import { lstatSync } from "node:fs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ParkFs, SignalParkError, parkReason, isAtomicTemp, equalManifest, refuse, type ParkFsOptions, type ParkReason } from './park-fs.ts';
import { assertSignalQuiescent, type FenceProbes } from './park-fence.ts';
import { bundleNameSchema, connectionSnapshot, excludeBundle, installationBinding, parkSchema, pathsFor, readConnection, readControl, sameRoot, writeControl,
  type ParkControl, type ParkJournal } from './park-control.ts';
export interface ParkOptions extends ParkFsOptions { fence?: FenceProbes }
export type KeptAdvisory = { kind: 'earlier' | 'moved' | 'unreadable'; folder: string };
export type ParkVerdict = { state: 'ready'; kept?: KeptAdvisory; durabilityLimited?: boolean } |
  { state: 'held'; reason: ParkReason; folder: string; dualCopy: boolean; canKeepBoth: boolean; pendingReplacement?: boolean };
type Locations = Record<'auth' | 'channel', 'live' | 'bundle' | 'absent'>;
type Candidate = { name: string; journal: ParkJournal; locations: Locations };
export function journalPath(io: ParkFs, name: string) { return join(pathsFor(io.root).bundles, name, 'park.json'); }
const livePath = (io: ParkFs, key: 'auth' | 'channel') => key === 'auth' ? pathsFor(io.root).signal : pathsFor(io.root).channel;
const bundlePath = (io: ParkFs, name: string, key: 'auth' | 'channel') => join(pathsFor(io.root).bundles, name, key === 'auth' ? 'signal' : 'channels-signal');
export function saveJournal(io: ParkFs, journal: ParkJournal) { journal.seq++; io.write(journalPath(io,journal.bundleName), parkSchema.parse(journal)); }
export function enumerateSignalBundles(io: ParkFs): string[] {
  const names = io.list(pathsFor(io.root).bundles, 64);
  for (const name of names) { if (!bundleNameSchema.safeParse(name).success || !io.checked(join(pathsFor(io.root).bundles,name))?.isDirectory()) refuse('unsafe'); }
  return names;
}
export function reserveBundleName(io: ParkFs, control: ParkControl, id: string, generation: number) {
  const names = enumerateSignalBundles(io); if (names.length >= 64) refuse('bound');
  for (let n = 1; n <= 64; n++) {
    const name = `${id}.g${generation}${n === 1 ? '' : `.${n}`}`; bundleNameSchema.parse(name);
    if (!names.includes(name) && !control.decisions[name]) return name;
  }
  return refuse('bound');
}
export function locateComponents(io: ParkFs, journal: ParkJournal): Locations {
  const locations = {} as Locations;
  for (const key of ['auth','channel'] as const) {
    const live = io.checked(livePath(io,key)), bundled = io.checked(bundlePath(io,journal.bundleName,key)), expected = journal.components[key];
    if (!expected.present) { if (live || bundled) refuse('conflict'); locations[key] = 'absent'; continue; }
    if (Boolean(live) === Boolean(bundled)) refuse('conflict');
    const path = live ? livePath(io,key) : bundlePath(io,journal.bundleName,key);
    if (!equalManifest(io.fingerprint(path,key === 'auth'),expected)) refuse('changed');
    locations[key] = live ? 'live' : 'bundle';
    if (key === 'channel' && journal.connection && JSON.stringify(connectionSnapshot(readConnection(io,path))) !== JSON.stringify(journal.connection)) refuse('changed');
  }
  return locations;
}
function finalLive(io: ParkFs, bundledAuth: boolean) {
  const a = io.checked(pathsFor(io.root).signal), c = io.checked(pathsFor(io.root).channel);
  if (a) io.fingerprint(pathsFor(io.root).signal,true);
  if (c) { io.fingerprint(pathsFor(io.root).channel); readConnection(io,pathsFor(io.root).channel); }
  if(c){
    const live=readConnection(io,pathsFor(io.root).channel),control=readControl(io);
    for(const [name,decision] of Object.entries(control.decisions)){
      if(decision.kind==='cleanup'&&decision.manifest.connection?.connectionId===live.connectionId&&!sameRoot(io,decision.manifest))refuse('conflict');
      if(decision.kind==='held'&&decision.reason==='moved'){
        let j:ParkJournal|undefined;try{j=parkSchema.parse(JSON.parse(io.read(journalPath(io,name)).toString('utf8')));}catch{/* Opaque terminal evidence cannot authorize old auth. */}
        if(j?.connection?.connectionId===live.connectionId)refuse('conflict');
      }
    }
  }
  if (a && !c) refuse('conflict');
  if(!a&&c&&bundledAuth){
    const live=readConnection(io,pathsFor(io.root).channel),control=readControl(io);
    for(const name of enumerateSignalBundles(io)){
      if(!io.checked(bundlePath(io,name,'auth')))continue;
      if(control.decisions[name]?.kind!=='held')refuse('conflict');
      // Explicit owner replacement accounts for opaque earlier auth; a held
      // complementary component of the same connection remains a blocking split.
      if(control.replacements.some(tx=>tx.phase==='ready'&&tx.freshId===live.connectionId&&(tx.oldBundles.includes(name)||tx.live?.bundleName===name)))continue;
      try{const j=parkSchema.parse(JSON.parse(io.read(journalPath(io,name)).toString('utf8')));if(j.connection&&j.connection.connectionId!==live.connectionId)continue;}catch{/* Unknown association stays paused. */}
      refuse('conflict');
    }
  }
}
export function verifyLive(io: ParkFs, journal: ParkJournal) {
  if (!sameRoot(io,journal)) return false;
  for (const key of ['auth','channel'] as const) {
    if (io.checked(bundlePath(io,journal.bundleName,key))) return false;
    if (!equalManifest(io.fingerprint(livePath(io,key),key === 'auth'),journal.components[key])) return false;
  }
  if (journal.components.channel.present && journal.connection && JSON.stringify(connectionSnapshot(readConnection(io,pathsFor(io.root).channel))) !== JSON.stringify(journal.connection)) return false;
  return true;
}
/** Only exact bookkeeping after a verified restored state. Never recursively removes. */
export function cleanupRestored(io: ParkFs, control: ParkControl, journal: ParkJournal) {
  if (journal.state !== 'restored' || !verifyLive(io,journal)) return;
  const dir = join(pathsFor(io.root).bundles,journal.bundleName);
  if (!io.checked(dir)) { io.barrier(pathsFor(io.root).bundles); return; }
  const names = io.list(dir,4096);
  for (const name of names) {
    if (name !== 'park.json' && !/^park\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(name)) return;
    const st = io.checked(join(dir,name),true); if (!st?.isFile() || st.size > 64*1024) return;
  }
  if (!control.decisions[journal.bundleName]) {
    control.decisions[journal.bundleName] = { kind: 'cleanup', manifest: journal }; writeControl(io,control);
  } else if (control.decisions[journal.bundleName]?.kind !== 'cleanup') return;
  io.barrier(dir); // repeats an interrupted unlink's barrier even with absent journal
  for (const name of names.filter(n=>n !== 'park.json')) io.unlink(join(dir,name));
  io.unlink(join(dir,'park.json'));
  io.rmdir(dir);
}
function reconcile(io: ParkFs, control: ParkControl, candidate: Candidate, direction: 'park' | 'restore') {
  const { journal } = candidate;
  // Retry both parents before interpreting a previously committed rename.
  for (const key of ['auth','channel'] as const) {
    if (io.checked(join(pathsFor(io.root).bundles,journal.bundleName))) io.barrier(join(pathsFor(io.root).bundles,journal.bundleName));
    const parent = key === 'auth' ? io.root : join(io.root,'channels'); if (io.checked(parent)) io.barrier(parent);
  }
  journal.state = direction === 'park' ? 'parking' : 'restoring'; saveJournal(io,journal);
  const order = direction === 'park' ? ['channel','auth'] as const : ['auth','channel'] as const;
  for (const key of order) {
    const locations = locateComponents(io,journal), desired = direction === 'park' ? 'bundle' : 'live';
    if (locations[key] === 'absent' || locations[key] === desired) continue;
    journal.next = { component: key, direction }; saveJournal(io,journal);
    const from = direction === 'park' ? livePath(io,key) : bundlePath(io,journal.bundleName,key);
    const to = direction === 'park' ? bundlePath(io,journal.bundleName,key) : livePath(io,key);
    if (direction === 'restore' && key === 'channel') io.mkdir(join(io.root,'channels'));
    io.move(from,to,journal.components[key],key === 'auth');
    // C is parsed at its actual location; never read absent live C after A moved.
    if (key === 'channel' && journal.connection && JSON.stringify(connectionSnapshot(readConnection(io,to))) !== JSON.stringify(journal.connection)) refuse('changed');
    journal.next = null; saveJournal(io,journal);
  }
  locateComponents(io,journal);
  journal.state = direction === 'park' ? 'parked' : 'restored'; journal.next = null; saveJournal(io,journal);
  if (direction === 'restore') cleanupRestored(io,control,journal);
}
function discover(io: ParkFs, control: ParkControl): { candidates: Candidate[]; kept?: KeptAdvisory; bundledAuth: boolean } {
  const candidates: Candidate[] = []; let kept: KeptAdvisory | undefined, bundledAuth = false;
  for (const name of enumerateSignalBundles(io)) {
    const folder = join(pathsFor(io.root).bundles,name), decision = control.decisions[name];
    if (decision?.kind === 'cleanup') {
      // A receipt never grants restoration, even if bundled data reappeared.
      if (io.checked(join(folder,'signal')) || io.checked(join(folder,'channels-signal'))) refuse('conflict');
      cleanupRestored(io,control,decision.manifest); continue;
    }
    if (decision?.kind === 'held') {
      bundledAuth ||= !!io.checked(join(folder,'signal'));
      kept = { kind: decision.reason === 'moved' ? 'moved' : decision.reason === 'unreadable' ? 'unreadable' : 'earlier', folder }; continue;
    }
    let journal: ParkJournal;
    try {
      for(const temp of io.list(folder,4096).filter(n=>/^park\.json\..*\.tmp$/.test(n))){
        if(!isAtomicTemp(temp,'park.json'))refuse('unsafe');
        const st=io.checked(join(folder,temp),true);if(!st?.isFile()||st.size>64*1024)refuse('unsafe');
      }
      journal = parkSchema.parse(JSON.parse(io.read(join(folder,'park.json')).toString('utf8')));
      if (journal.bundleName !== name) refuse('unsafe');
    } catch {
      excludeBundle(io,control,name,'unreadable',undefined);
      bundledAuth ||= !!io.checked(join(folder,'signal')); kept = { kind: 'unreadable',folder }; continue;
    }
    if (journal.state === 'held') { excludeBundle(io,control,name,journal.held!.reason,journal); bundledAuth ||= journal.components.auth.present; kept = { kind: 'earlier', folder }; continue; }
    if (!sameRoot(io,journal)) { excludeBundle(io,control,name,'moved',journal); bundledAuth ||= journal.components.auth.present; kept = { kind: 'moved',folder }; continue; }
    const liveC = io.checked(pathsFor(io.root).channel), bundledC = io.checked(join(folder,'channels-signal'));
    if (liveC && bundledC) {
      const live = readConnection(io,pathsFor(io.root).channel);
      if (live.connectionId === journal.connection?.connectionId && live.generation > journal.connection.generation) {
        excludeBundle(io,control,name,'superseded',journal); bundledAuth ||= journal.components.auth.present; kept = { kind:'earlier',folder }; continue;
      }
      // A distinct ID has no custody-transfer proof, regardless of generation.
      refuse('conflict');
    }
    // Intent-only/evolved-live exception cannot include any bundled required data.
    const noBundled = !io.checked(join(folder,'signal')) && !io.checked(join(folder,'channels-signal'));
    if (noBundled && (journal.state === 'parking' || journal.state === 'restored') && (['auth','channel'] as const).every(key=>Boolean(io.checked(livePath(io,key)))===journal.components[key].present) && !verifyLive(io,journal)) {
      finalLive(io,false); excludeBundle(io,control,name,'superseded',journal); kept = { kind: 'earlier',folder }; continue;
    }
    let locations: Locations;
    try { locations = locateComponents(io,journal); }
    catch (error) { excludeBundle(io,control,name,error instanceof SignalParkError && error.reason === 'changed' ? 'unreadable' : 'conflict',journal); throw error; }
    candidates.push({ name,journal,locations });
  }
  return { candidates,kept,bundledAuth };
}
function choose(io: ParkFs, control: ParkControl, candidates: Candidate[]): Candidate | undefined {
  if (!candidates.length) return;
  if (candidates.filter(c=>Object.values(c.locations).includes('live') && Object.values(c.locations).includes('bundle')).length > 1) refuse('conflict');
  const ids = new Set(candidates.map(c=>c.journal.connection!.connectionId));
  if (ids.size !== 1) refuse('conflict');
  const max = Math.max(...candidates.map(c=>c.journal.connection!.generation));
  const winners = candidates.filter(c=>c.journal.connection!.generation === max);
  if (winners.length !== 1) refuse('conflict');
  const winner = winners[0]!;
  for (const loser of candidates.filter(c=>c !== winner)) excludeBundle(io,control,loser.name,'superseded',loser.journal,true);
  return winner;
}
export function barrierSignalRecoveryParents(io:ParkFs,names=enumerateSignalBundles(io)) {
  for(const dir of [io.root,join(io.root,'channels'),join(io.root,'recovery-quarantine'),join(io.root,'recovery-quarantine/signal-park-control'),pathsFor(io.root).bundles,...names.map(name=>join(pathsFor(io.root).bundles,name))])if(io.checked(dir))io.barrier(dir);
}
function runRecovery(io: ParkFs, options: ParkOptions, mode: 'startup' | 'downgrade' | 'replayed'): ParkVerdict {
  const p = pathsFor(io.root), control = readControl(io);
  const names = enumerateSignalBundles(io);
  const present = !!io.checked(p.signal) || !!io.checked(p.channel) || names.length > 0 || control.replacements.length > 0 || control.child !== null;
  if (!present) return { state: 'ready' };
  assertSignalQuiescent(io,control,options.fence,false);
  barrierSignalRecoveryParents(io,names);
  if (control.replacements.length) {
    if(mode==='startup'||control.replacements.some(tx=>tx.phase!=='ready'))return { state: 'held',reason: 'conflict',folder:p.bundles,dualCopy:false,canKeepBoth:false,pendingReplacement:true };
    if(mode==='downgrade')assertSignalDowngradeAuthority(io,control);
  }

  for(const [name,decision] of Object.entries(control.decisions)) {
    if(decision.kind==='cleanup'&&!names.includes(name)&&io.checked(p.bundles))io.barrier(p.bundles);
  }
  const found = discover(io,control);
  const candidate = choose(io,control,found.candidates);
  if (candidate) {
    if(control.replacements.some(tx=>tx.connectionIds.includes(candidate.journal.connection!.connectionId)))refuse('conflict');
    assertSignalQuiescent(io,control,options.fence);
    reconcile(io,control,candidate,mode === 'downgrade' && ['parking','parked'].includes(candidate.journal.state) ? 'park' : 'restore');
    if (mode === 'downgrade' && candidate.journal.state === 'parked') return { state:'ready',durabilityLimited:io.durabilityLimited };
  }
  if(io.checked(p.channel)&&control.replacements.some(tx=>tx.connectionIds.includes(readConnection(io,p.channel).connectionId)))refuse('conflict');
  finalLive(io,found.bundledAuth);
  const loser=found.candidates.find(c=>c!==candidate&&control.decisions[c.name]?.kind==='held');
  const kept=found.kept??(loser?{kind:'earlier' as const,folder:join(p.bundles,loser.name)}:undefined);
  return { state:'ready',...(kept ? { kept } : {}), durabilityLimited:io.durabilityLimited };
}
/** No component/custody state means no Signal preservation work or permission repair. */
export function signalCustodyMayExist(root:string):boolean{
  for(const parent of ['channels','recovery-quarantine']){try{const st=lstatSync(join(root,parent));if(!st.isDirectory()||st.isSymbolicLink())return true;}catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;}}
  for(const name of ['signal','channels/signal','recovery-quarantine/signal-parked','recovery-quarantine/signal-park-control']){try{lstatSync(join(root,name));return true;}catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;}}
  return false;
}
export function recoverSignalPark(root: string, options: ParkOptions = {}): ParkVerdict {
  let io: ParkFs | undefined;
  // Unknown control is conservatively a replay obligation. Capture readable
  // history before discovery/fence/barrier failures can hide it from startup.
  let pendingReplacement=true;
  try { if(!signalCustodyMayExist(root))return{state:'ready'};io = new ParkFs(root,options);pendingReplacement=readControl(io).replacements.length>0;return runRecovery(io,options,'startup'); }
  catch (error) {
    const reason = parkReason(error);
    let dualCopy=false,canKeepBoth=false;
    if(io&&!['busy','adoption','durability','bound'].includes(reason)){
      try{
        const control=readControl(io),names=enumerateSignalBundles(io);installationBinding(io);
        assertSignalQuiescent(io,control,options.fence,false);
        const p=pathsFor(root);io.fingerprint(p.signal,true);io.fingerprint(p.channel);
        canKeepBoth=Object.keys(control.decisions).length+names.filter(n=>!control.decisions[n]).length<4096
          && control.replacements.length<64 && (!(io.checked(p.signal)||io.checked(p.channel))||names.length<64);
        for(const name of names){
          try{
            const j=parkSchema.parse(JSON.parse(io.read(journalPath(io,name)).toString('utf8')));
            if(!j.components.auth.present||!j.components.channel.present)continue;
            if((['auth','channel'] as const).every(key=>equalManifest(io!.fingerprint(livePath(io!,key),key==='auth'),j.components[key])&&equalManifest(io!.fingerprint(bundlePath(io!,name,key),key==='auth'),j.components[key])))dualCopy=true;
          }catch{/* Missing/unreadable data never grants the dual-copy claim. */}
        }
      }catch{/* A prerequisite cannot be proved; expose only Show folder. */}
    }
    return { state:'held',reason,folder:join(root,'recovery-quarantine/signal-parked'),dualCopy,canKeepBoth,...(pendingReplacement?{pendingReplacement:true}:{}) };
  }
}
/** Only the store replay phase calls this, after revoking every retained transaction. */
export function reconcileSignalParkAfterAuthority(io:ParkFs,options:ParkOptions):ParkVerdict {
  return runRecovery(io,options,'replayed');
}
/** Synchronous because the installation downgrade holds a synchronous lease. */
export function parkSignalForDowngrade(root: string, options: ParkOptions = {}) {
  if(!signalCustodyMayExist(root))return{parked:false,durabilityLimited:false};
  const io = new ParkFs(root,options), p = pathsFor(root);
  const verdict = runRecovery(io,options,'downgrade'); if (verdict.state === 'held') refuse(verdict.reason);
  const control = readControl(io);
  // A parked same-phase retry has no live components, and creates no second bundle.
  if (!io.checked(p.signal) && !io.checked(p.channel)) return { parked:enumerateSignalBundles(io).length>0, durabilityLimited:io.durabilityLimited };
  // All validation is read-only before directory creation/adoption publication.
  if (!io.checked(p.channel)) refuse('conflict');
  const record = readConnection(io,p.channel);
  const components = { auth:io.fingerprint(p.signal,true),channel:io.fingerprint(p.channel) };
  const binding = installationBinding(io);
  assertSignalQuiescent(io,control,options.fence,false);
  const name = reserveBundleName(io,control,record.connectionId,record.generation);
  const journal: ParkJournal = { version:3,runId:randomUUID(),bundleName:name,seq:0,state:'parking',next:null,...binding,connection:connectionSnapshot(record),components,parkedBy:'1.0.19',parkedAt:Date.now() };
  assertSignalQuiescent(io,control,options.fence);
  io.mkdir(join(p.bundles,name)); saveJournal(io,journal);
  reconcile(io,control,{ name,journal,locations:{ auth:components.auth.present?'live':'absent',channel:'live' } },'park');
  return { parked:true,durabilityLimited:io.durabilityLimited };
}

/** Service/link admission never performs late credential restoration. */
export function assertSignalServiceAllowed(root: string, options: ParkOptions = {}) {
  const io = new ParkFs(root,options), control = readControl(io); let bundledAuth = false;
  for (const name of enumerateSignalBundles(io)) {
    if (!control.decisions[name]) {
      const j=parkSchema.parse(JSON.parse(io.read(journalPath(io,name)).toString('utf8')));
      if(j.state!=='restored'||!verifyLive(io,j))refuse('conflict');
    }
    bundledAuth ||= !!io.checked(join(pathsFor(root).bundles,name,'signal'));
  }
  if (control.replacements.some(tx=>tx.phase!=='ready')) refuse('conflict');
  finalLive(io,bundledAuth);
}
export function assertSignalLinkAllowed(root: string, options: ParkOptions = {}) {
  const io = new ParkFs(root,options),control=readControl(io),names=enumerateSignalBundles(io),retire:ParkJournal[]=[];
  if(control.replacements.some(tx=>tx.phase!=='ready'))refuse('conflict');
  // Read-only complete classification precedes every terminal write. This gate
  // never restores credentials after construction.
  for(const name of names){
    if(control.decisions[name])continue;
    const j=parkSchema.parse(JSON.parse(io.read(journalPath(io,name)).toString('utf8')));
    if(!['parking','restored'].includes(j.state)||!sameRoot(io,j)||io.checked(bundlePath(io,name,'auth'))||io.checked(bundlePath(io,name,'channel'))
      ||!(['auth','channel'] as const).every(key=>Boolean(io.checked(livePath(io,key)))===j.components[key].present))refuse('conflict');
    finalLive(io,false);retire.push(j);
  }
  for(const j of retire)excludeBundle(io,control,j.bundleName,'superseded',j,true);
  for(const name of names){if(!control.decisions[name])refuse('conflict');io.barrier(join(root,'recovery-quarantine/signal-park-control'),true);}
  assertSignalServiceAllowed(root,options);
}
