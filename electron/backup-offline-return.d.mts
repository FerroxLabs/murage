export interface ReturnDestination { kind:string; args?:string[]; version?:string }
export interface ReturnResult { status:"stopped"|"leaving"|"quit" }
export interface ReturnOptions {
  prepare?:()=>ReturnDestination; destination?:ReturnDestination;
  afterCleanup?:()=>void; retry?:boolean;
}
export interface ReturnAuthority {
  userQuitRequested:boolean; generation:number; leaving:boolean; internalQuit:boolean;
  attempt:{promise:Promise<ReturnResult>;generation:number;destination?:ReturnDestination}|null;
  quitAttempt:Promise<ReturnResult>|null; failedReturn?:unknown; cancelGate?:()=>void;
}
export interface BackupReturn {
  (options?:ReturnOptions):Promise<ReturnResult>;
  retry(options?:ReturnOptions):Promise<ReturnResult>;
}
export interface ReturnDependencies {
  app:{quit():void;exit(code:number):void;murageShutdownCause?:string};
  authority?:ReturnAuthority; cleanup:()=>Promise<unknown>;
  takeProgress?:()=>{destroy():void}|null;
  onFailure?:(error:unknown)=>void; onLeaving?:()=>void;
  graceMs?:number; setTimer?:(fn:()=>void,ms:number)=>unknown; log?:(line:string)=>void;
}
export function createReturnAuthority():ReturnAuthority;
export function revokeReturn(authority:ReturnAuthority):void;
export function createBackupReturn(options:ReturnDependencies & {
  relaunch:(destination:ReturnDestination)=>void; shutdownStarted?:()=>boolean;
}):BackupReturn;
export function joinExplicitQuit(options:ReturnDependencies & {scheduleExit?:(fn:()=>void)=>unknown}):Promise<ReturnResult>;
export function quitForRelaunch(options:Pick<ReturnDependencies,"app"|"graceMs"|"setTimer"|"log"> & {progress?:{destroy():void}|null;reopening?:boolean}):void;
export const BACKUP_QUIT_GRACE_MS:number;
export const OFFLINE_BACKUP_CEILING_MS:number;
export function offlineCeilingFor(budgetMs?:number):number;
export function runOfflineBackup(options:{
  run:()=>Promise<unknown>;abandon:()=>unknown;returnToWorkspace:()=>Promise<ReturnResult|void>;
  shutdownStarted:()=>boolean;showBackupMode:()=>void;destroyProgress:()=>void;
  showCleanupFailure?:(error:unknown)=>void;ceilingMs?:number;
  setTimer?:(fn:()=>void,ms:number)=>unknown;clearTimer?:(timer:unknown)=>void;
  log?:(line:string)=>void;operation?:{assertActive():void;terminal():void};
}):Promise<string>;
