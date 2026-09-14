export function trustedBackupResticExecutable(file:string):boolean;
export function signedResticOwnedByCurrentApp(file:string,bytes:Buffer,options?:{
 currentExecutable?:string;
 run?:(args:string[])=>{status:number|null;error?:unknown;stderr?:string|Buffer};
}):boolean;
