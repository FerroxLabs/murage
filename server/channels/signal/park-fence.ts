// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { readlinkSync, opendirSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { validBoot, validUptime, provedOwnerReboot, localHost, sameMachine, bootSession, uptimeMs, linuxProcStat, processIsAlive, probeProcessStartSync, dataDirLeasePaths, currentDataDirLeaseEpoch, validProcessStart } from '../../../electron/data-dir-lease.mjs';
import { readProcBytes, sameInitialProcessRoot } from './park-proc.ts';
import { ParkFs, refuse, absent } from './park-fs.ts';
import { readControl, writeControl, type ParkControl } from './park-control.ts';
export interface FenceProbes {
  platform?: NodeJS.Platform;
  lease?: () => string | null;
  host?: () => string; boot?: () => string | null; uptime?: () => number | null;
  alive?: (pid: number) => boolean;
  start?: (pid: number) => string | null;
  /** true only after complete native discovery; false/throw is never an empty scan. */
  discover?: (authPath: string, deadline: number) => boolean;
}
const coverage = new Map<string, { epoch: string; host: string; boot: string | null; lease: string }>();
const canonicalConfig = (path: string) => dataDirLeasePaths(path).canonicalDataDir;

/** Complete Linux adoption scan. Any inaccessible/malformed/churning PID refuses. */
export function discoverSignalChildren(authPath: string, deadline: number): boolean {
  try {
    // An inner namespace cannot enumerate an earlier host child. Linux's initial
    // PID namespace has this reserved inode; unknown kernels refuse conservatively.
    if (readlinkSync('/proc/self/ns/pid') !== 'pid:[4026531836]' || readlinkSync('/proc/1/ns/pid') !== 'pid:[4026531836]') return false;
    if(readlinkSync('/proc/self/ns/mnt')!==readlinkSync('/proc/1/ns/mnt'))return false;
    if(!sameInitialProcessRoot())return false;
    const mountBytes=readProcBytes('/proc/self/mountinfo',1024*1024,deadline);if(!mountBytes)return false;
    const mounts=mountBytes.toString('utf8');
    if (!mounts.split('\n').some(line => / \/proc .* - proc /.test(line)) || /hidepid=(?:[1-9]|invisible|noaccess|ptraceable)/.test(mounts)) return false;
    const ownNamespace = readlinkSync('/proc/self/ns/pid'), target = canonicalConfig(authPath);
    const dir = opendirSync('/proc'); let pids = 0, total = 0;
    try {
      for (;;) {
        if (Date.now() > deadline) return false;
        const ent = dir.readSync(); if (!ent) break;
        if (!/^[1-9][0-9]*$/.test(ent.name)) continue;
        if (++pids > 65_536) return false;
        const pid = Number(ent.name);
        try {
          if (readlinkSync(`/proc/${pid}/ns/pid`) !== ownNamespace) return false;
          const first = linuxProcStat(pid); if (!first) { if (!processIsAlive(pid)) continue; return false; }
          // proc files report size zero. A bounded fd read is required here too.
          const raw=readProcBytes(`/proc/${pid}/cmdline`,1024*1024,deadline);if(!raw)return false;
          if (raw.length > 1024 * 1024 || (total += raw.length) > 64 * 1024 * 1024) return false;
          const last = linuxProcStat(pid);
          if (!last || last[1] !== first[1]) { if (!processIsAlive(pid)) continue; return false; }
          if (first[0] === 'Z' || first[0] === 'X') continue;
          if (!raw.length) continue; // readable kernel thread, not an argv match
          if (raw[raw.length - 1] !== 0 || raw.toString('utf8').includes('\ufffd')) return false;
          const argv = raw.toString('utf8').slice(0, -1).split('\0');
          if (!argv[0]) return false;
          if (!/^java(?:\.exe)?$/i.test(basename(argv[0]))) continue;
          const jar=argv.indexOf('-jar');
          if(!argv.includes('org.asamk.signal.Main')&&!(jar>=0&&/^signal-cli(?:-[0-9][a-zA-Z0-9_.-]*)?\.jar$/.test(basename(argv[jar+1]??''))))continue;
          const configs = argv.flatMap((arg, i) => arg === '--config' ? [argv[i + 1] ?? ''] : arg.startsWith('--config=') ? [arg.slice(9)] : []);
          if (configs.length !== 1) return false;
          for (const config of configs) {
            if (!config || !isAbsolute(config)) return false;
            if (canonicalConfig(config) === target) return false;
          }
        } catch (error) { if (absent(error) && !processIsAlive(pid)) continue; return false; }
      }
    } finally { dir.closeSync(); }
    return true;
  } catch { return false; }
}

export function assertSignalQuiescent(io: ParkFs, control: ParkControl, probes: FenceProbes = {}, publish = true) {
  const readLease=()=>probes.lease?probes.lease():currentDataDirLeaseEpoch(io.root);
  const lease=readLease();if(!lease)refuse('adoption');
  const platform = probes.platform ?? io.platform, host = (probes.host ?? localHost)(), boot = (probes.boot ?? bootSession)(), up = (probes.uptime ?? uptimeMs)();
  if (!host || host.length > 255) refuse('adoption');
  const child = control.child;
  if((boot!==null&&!validBoot(boot))||(up!==null&&!validUptime(up)))refuse(child?'busy':'adoption');
  if (child) {
    if (!sameMachine(child,host,boot)) refuse('busy');
    const reboot = provedOwnerReboot(child,boot,up);
    if (!reboot && child.state !== 'exited') {
      if (!child.pid || child.state === 'spawning') refuse('busy');
      let live:boolean;try{live=(probes.alive ?? processIsAlive)(child.pid);}catch{return refuse("busy");}
      if (live) {
        if (platform === 'darwin') refuse('busy');
        const start = probes.start ? probes.start(child.pid) : (platform === 'linux' ? linuxProcStat(child.pid)?.[1] ?? null : platform === 'win32' ? probeProcessStartSync(child.pid) : null);
        if (!validProcessStart(child.start, platform) || !validProcessStart(start, platform) || child.start === start) refuse('busy');
      }
    }
  }
  const existing = coverage.get(io.root);
  if (!existing || !child || child.epoch !== existing.epoch || existing.host !== host || existing.boot !== boot || existing.lease !== lease) {
    const deadline = Math.min(io.deadline, Date.now() + 5000);
    let complete=false;
    try { complete=probes.discover ? probes.discover(join(io.root, 'signal/auth'), deadline)
      : platform === 'linux' && discoverSignalChildren(join(io.root, 'signal/auth'), deadline); } catch { refuse('adoption'); }
    if (!complete) refuse('adoption');
    // Read-only preflight must not publish adoption before filesystem validation.
    if(readLease()!==lease)refuse('adoption');
    if (!publish) return;
    const epoch = randomUUID();
    control.child = { token: randomUUID(), epoch, host, boot, uptime: up, generation: child?.generation ?? 0, state: 'exited', pid: null, start: null };
    writeControl(io, control, true);
    coverage.set(io.root, { epoch, host, boot, lease });
  }
}
export function beginSignalChild(io: ParkFs, generation: number, probes: FenceProbes = {}) {
  const control = readControl(io); assertSignalQuiescent(io, control, probes);
  const child = { ...control.child!, token: randomUUID(), generation, state: 'spawning' as const, pid: null, start: null };
  control.child = child; writeControl(io, control, true); return child.token;
}
export function publishSignalChild(io: ParkFs, token: string, pid: number | undefined, probes: FenceProbes = {}) {
  const control = readControl(io);
  if (control.child?.token !== token || control.child.state !== 'spawning' || !pid) refuse('busy');
  const platform = probes.platform ?? io.platform;
  const start = probes.start ? probes.start(pid) : (platform === 'linux' ? linuxProcStat(pid)?.[1] ?? null : platform === 'win32' ? probeProcessStartSync(pid) : null);
  if (platform !== 'darwin' && !validProcessStart(start, platform)) refuse('busy');
  control.child = { ...control.child, pid, start, state: 'running' }; writeControl(io, control, true);
}
export function exitSignalChild(io: ParkFs, token: string) {
  const control = readControl(io); if (control.child?.token !== token) refuse('busy');
  control.child = { ...control.child, state: 'exited' }; writeControl(io, control, true);
}
