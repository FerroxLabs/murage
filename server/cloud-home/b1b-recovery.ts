// SPDX-License-Identifier: AGPL-3.0-or-later
import { cloudHomeCopy } from "./copy.ts";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { TURN_LAUNCHER } from "./turn-process.ts";
/** Fixed sudo mode; no paths, executable, credentials or environment in argv. */
export function wipeHomeEngineSignIns(): Promise<void> {
  return new Promise((resolve,reject) => {
    const child=spawn("/usr/bin/sudo",["-n","-C","4","--",TURN_LAUNCHER],{stdio:["ignore","ignore","ignore","pipe"],env:{PATH:"/usr/bin:/bin"}});
    const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error(cloudHomeCopy.homeSignInCleanupTimedOut));},30_000);
    child.once("error",()=>{clearTimeout(timer);reject(new Error(cloudHomeCopy.homeSignInCleanupUnavailable));});
    child.once("exit",code=>{clearTimeout(timer);if(code === 0)resolve();else reject(new Error(cloudHomeCopy.homeSignInCleanupFailed));});
    const pipe=child.stdio[3] as Writable;
    pipe.on("error",()=>{child.kill("SIGKILL");});
    pipe.end(JSON.stringify({mode:"engine-signin-cleanup"}));
  });
}
/** Each operation is mandatory and acknowledged before a replacement can pair. */
export function createHomeRecoveryCleanup(options: {
  stopWork(): Promise<void>;
  pauseChannels(): Promise<void>;
  wipeEngineSignIns(): Promise<void>;
  rotateConnectedAppsAndFlux(): Promise<void>;
}) {
  let active: Promise<void> | undefined;
  return (): Promise<void> => {
    if (active) return active;
    active = (async () => {
      await options.stopWork();
      await options.pauseChannels();
      await options.wipeEngineSignIns();
      await options.rotateConnectedAppsAndFlux();
    })().finally(() => { active=undefined; });
    return active;
  };
}
/** Server start: thaw and clean any antigravity `.agents` freeze a crashed turn left behind (fixed sudo mode, no arguments). */
export function sweepAgyFreezes(): Promise<void> {
  return new Promise((resolve,reject) => {
    const child=spawn("/usr/bin/sudo",["-n","-C","4","--",TURN_LAUNCHER],{stdio:["ignore","ignore","ignore","pipe"],env:{PATH:"/usr/bin:/bin"}});
    const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error(cloudHomeCopy.agyFreezeSweepFailed));},30_000);
    child.once("error",()=>{clearTimeout(timer);reject(new Error(cloudHomeCopy.agyFreezeSweepFailed));});
    child.once("exit",code=>{clearTimeout(timer);if(code === 0)resolve();else reject(new Error(cloudHomeCopy.agyFreezeSweepFailed));});
    const pipe=child.stdio[3] as Writable;
    pipe.on("error",()=>{child.kill("SIGKILL");});
    pipe.end(JSON.stringify({mode:"agy-unfreeze-sweep"}));
  });
}
