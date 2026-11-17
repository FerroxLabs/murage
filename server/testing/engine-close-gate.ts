// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Hold only the fake engine's close notification, after its real OS exit.
 * Windows TerminateProcess has no catchable SIGTERM. Exit alone still does
 * not prove that stdio/descendants closed: the driver must join `close`.
 * This preload gives that boundary explicit ready/release markers on every OS.
 * It neither changes the driver's events nor the folder lease registry.
 */
export function engineCloseGate(root: string) {
  const ready = join(root, "engine-close-ready"), release = join(root, "engine-close-release"), waiting = join(root, "admission-waiting");
  const preload = join(root, "engine-close-gate.mjs");
  const fake = fileURLToPath(new URL("./fake-claude-cli.ts", import.meta.url));
  writeFileSync(preload, `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {existsSync,writeFileSync} from 'node:fs';
const timeout=globalThis.setTimeout;
globalThis.setTimeout=function(...args){
  if(new Error().stack.includes('project-turn-leases.ts'))writeFileSync(${JSON.stringify(waiting)},'admission waiting');
  return timeout(...args);
};
const spawn=cp.spawn;
cp.spawn=function(file,args,...rest){
  const child=spawn.call(this,file,args,...rest);
  if((file===${JSON.stringify(fake)} || args?.includes(${JSON.stringify(fake)})) && args?.includes("--output-format")){
    const emit=child.emit;
    child.emit=function(event,...values){
      if(event!=='close')return emit.call(this,event,...values);
      writeFileSync(${JSON.stringify(ready)},'close pending');
      const timer=setInterval(()=>{
        if(existsSync(${JSON.stringify(release)})){
          clearInterval(timer);emit.call(this,event,...values);
        }
      },10);
      return true;
    };
  }
  return child;
};
syncBuiltinESMExports();
`);
  return { ready, release, waiting, args: ["--import", pathToFileURL(preload).href] };
}
