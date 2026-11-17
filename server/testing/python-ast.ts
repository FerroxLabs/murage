import {spawnSync, type SpawnSyncReturns} from "node:child_process";

/** Match the repo resolution in server/busyloop-parity.test.ts:66 and server/drivers/busyloop-transport.test.ts:19. */
export function repoPythonCommand(): string { return process.platform === "win32" ? "python" : "python3"; }

/** Keep AST errors visible; only an absent launcher advances to the next command. */
export function pythonAstOutput(file: string, script: string, text: string, first?: SpawnSyncReturns<string>): string {
 const initial=repoPythonCommand(), attempted=[initial];
 let result=first ?? spawnSync(initial,["-c",script],{input:text,encoding:"utf8"});
 const fallbacks=[["py","-3"],["python3"],["python"]].filter(command=>command.join(" ")!==initial);
 for(let index=0;;index++) {
  const detail=`attempted: ${attempted.join(", ")}`;
  if((result.error as NodeJS.ErrnoException | undefined)?.code!=="ENOENT") {
   if(result.error || result.status!==0) throw Error(`${file}: Python (${detail}): ${result.error?.message || result.stderr || `exit ${result.status}`}`);
   return result.stdout;
  }
  const command=fallbacks[index];
  if(!command) throw Error(`${file}: Python launcher unavailable (${detail}): ${result.error?.message}`);
  attempted.push(command.join(" "));
  result=spawnSync(command[0],[...command.slice(1),"-c",script],{input:text,encoding:"utf8"});
 }
}
