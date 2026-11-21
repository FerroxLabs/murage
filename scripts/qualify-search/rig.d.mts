export function runRig(args: {worktree:string;tip:string;base?:string;tools?:string;registry?:string;out?:string;smoke?:boolean}):Promise<{raw:{commands:unknown[];[key:string]:unknown};pass:Record<string,boolean>}>;

export function compareRig(baseDir:string,tipDir:string,gateRC:number,options?:{newFiles?:string[];merged?:boolean}):{raw:Record<string,unknown>;pass:Record<string,boolean>};
export function mergedShardSource(source:string):string;
export function mergedShardArgs(out:string):string[];
