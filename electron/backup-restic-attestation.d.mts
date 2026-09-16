export function trustedBackupResticExecutable(file:string):boolean;
export function signedResticOwnedByCurrentApp(file:string,bytes:Buffer,options?:{
 currentExecutable?:string;
 run?:(args:string[])=>{status:number|null;error?:unknown;stderr?:string|Buffer};
}):boolean;

export function trustedBackupResticExecutableAsync(file:string,options?:{currentExecutable?:string;signal?:AbortSignal;run?:(args:string[],options?:{signal?:AbortSignal})=>Promise<{status:number|null;error?:unknown;stderr?:string|Buffer}>}):Promise<boolean>;
export function signedResticOwnedByCurrentAppAsync(file:string,bytes:Buffer,options?:{currentExecutable?:string;signal?:AbortSignal;run?:(args:string[],options?:{signal?:AbortSignal})=>Promise<{status:number|null;error?:unknown;stderr?:string|Buffer}>}):Promise<boolean>;
