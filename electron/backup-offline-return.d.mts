export interface BackupReturn { ():Promise<void>; retry():Promise<void> }
export function createBackupReturn(options:{app:{quit():void;exit(code:number):void};cleanup:()=>Promise<void>;relaunch:()=>void;takeProgress:()=>{destroy():void}|null;shutdownStarted?:()=>boolean;setTimer?:(fn:()=>void,ms:number)=>unknown}):BackupReturn;
export function runOfflineBackup(options:{run:()=>Promise<unknown>;abandon:()=>unknown;returnToWorkspace:()=>Promise<void>;shutdownStarted:()=>boolean;showBackupMode:()=>void;destroyProgress:()=>void;ceilingMs?:number}):Promise<string>;
