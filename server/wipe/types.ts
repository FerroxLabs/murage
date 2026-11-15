// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AlwaysAskHit } from '../always-ask.ts';
export type Dialect = 'sh' | 'pwsh' | 'cmd';
export type WordPart =
 | { k: 'lit'; s: string; quoted: boolean }
 | { k: 'var'; name: string; delayed?:boolean; op?: ':-'|'-'|':?'|'?'|':='|'='|':+'|'+'|'#'|'##'|'%'|'%%'|':'|'length'|'other'; arg?: Word; quoted: boolean }
 | { k: 'tilde'; user?: string }
 | { k: 'subst'; body: Script;quoted?:boolean }
 | {k:'value';value:Value}
 | {k:'array';words:Word[];loop?:boolean}
 | {k:'block';body:Script}
 | { k: 'glob'; s: string };
export type Word = { parts: WordPart[]; raw: string };
export type Redirect = { fd?: number; op: '>'|'>>'|'<'|'<<'|'<<-'|'<<<'|'&>'|'&>>'|'>&'|'<&'|'>|'|'<>'; target: Word; heredoc?: string; expanding?: boolean };
export type SimpleCommand = { assigns: { name: string; value: Word }[]; words: Word[]; redirects: Redirect[]; stdinHeredoc?: string };
export type Node = ({k:'block';body:Script} | {k:'func';name:string;body:Script} | { k: 'cmd'; c: SimpleCommand } | { k: 'group'; body: Script; subshell?: boolean } | { k:'subshell'; body:Script } | { k:'residual'; text:string; dialect:Dialect } | { k: 'pipe'; stages: Node[] } | { k: 'list'; items: Node[] }) & {join?:string;span:[number,number];cond?:boolean};
export type Script = { nodes: Node[]; incompleteTail: boolean; source?:string };
export type EntryOf={start:string;wholeTree:boolean;rootSelf?:boolean};
export type Value = { k: 'known'; s: string;entryOf?:EntryOf;entryAlternatives?:Value[]; wholeDirGlob?: boolean; dirsOnly?:boolean; callerGlobRelative?:boolean; candidates?:string[];mayOpaque?:boolean;glob?:import('./glob.ts').GlobSpec|{dir:string;pattern:string};globText?:string;recursiveGlob?:boolean;drive?:string } | { k: 'opaque'; why: string;entryOf?:EntryOf;entryAlternatives?:Value[] };
/** Options that belong to one shell process. */
export interface ProcOpts{nounset?:boolean;errexit?:boolean;allexport?:boolean;delayed?:boolean;strict?:boolean}
export type MaySet=Value & {values:string[];opaque:boolean;candidates?:string[];original?:string;maybeUnset?:boolean};
export type ShellState = { meter?:{calls:number};fnStack?:string[];proc?:ProcOpts;exported?:Set<string>;exportedFns?:Set<string>;inheritedFns?:Set<string>;family?:'fish'|'csh';noEnv?:boolean; pipeFrom?:Invocation; piped?:boolean; produced?:Map<string,Invocation>; blocks?:Map<string,Script[]>;locals?:{env:Map<string,string|undefined>;vars:Map<string,MaySet>;delayed?:boolean}[];successCwd?:Value;startCwd?:string;oldpwd?:Value;dirStack?:Value[];drive?:string;functions?:Map<string,Script[]>;functionDepth?:number;links?:Map<string,string>;weak?:boolean;defining?:boolean;lexicalProtected?:(path:string)=>boolean;stdin?:Value;vars?:Map<string,MaySet>;arrays?:Map<string,Value[]>;positional?:Value[];platform?:NodeJS.Platform; env: Map<string, string | undefined>; cwd: MaySet; home: string; dialect: Dialect; depth: number };
export type Invocation = {
 program: string; argv: Value[]; rawArgv: Word[];
 redirects: { op: Redirect['op']; target: Value }[];
 home?:string;env?:Map<string,string|undefined>;stdin?:Value;platform?:NodeJS.Platform;drive?:string;links?:Map<string,string>;stdout?:Value[];cwd: MaySet; dialect: Dialect; pipedFrom?: Invocation;
};
export type WipeEffect =
 | {k:'git-clean';target:Value;follow?:boolean}
 | { k: 'delete'; target: Value; recursive: boolean | 'unknown'; follow?:boolean }
 | { k: 'move-away'; source: Value; follow?:boolean }
 | { k: 'sync-wipe'; dest: Value; follow?:boolean }
 | { k: 'device-write'; target: Value }
 | { k: 'disk-tool'; tool: string }
 | { k: 'write'; target: Value }
 | { k: 'uncertain-operands'; program: string; words: Value[];follow?:boolean };
export type RootClass = 'fs-root'|'drive-root'|'home'|'homes-parent'|'os-dir'|'murage-data'|'project-root';
export type Verdict = { k: 'run' } | { k: 'card'; rule: AlwaysAskHit['rule'] | 'wipe-check-fault'; what: string; effect?: WipeEffect; root?: RootClass };
export interface PathStat {dev:number|bigint|string;ino:number|bigint|string;isSymbolicLink?():boolean}
export interface PathPort { confirmMount?(p:string):boolean|null; mountId?(p:string):string|null;lstat?(p:string):PathStat|null;stat?(p:string):PathStat|null;statfs?(p:string):{type:number|bigint}|null; realpath(p: string): string | null; isBlockDevice(p: string): boolean | null }
export interface RegistryStats { replaceCalls: number; trieNodesTouched: number; realpathCalls: number; queries: number;mountRefreshes:number }
export interface WipeContext {
 degraded?:boolean; cwd?: string; cwdOpaque?: boolean; workFolder?: string; project?: string; home?: string; dataDir?: string;
 env?: Readonly<Record<string,string|undefined>>; platform?: NodeJS.Platform;
 shell?: 'pwsh'; lang?: 'sh'|'pwsh'|'py'|'js'; dialect?: Dialect;
 /** Test/host ports are injected once; ordinary callers use the singleton. */
 pathPort?: PathPort; mountInventory?:{contains(path:string):boolean;has?(path:string):boolean;add?(path:string):void;drop?(path:string):void};
 registry?: { protectedChildren?(dir:string):string[];contains(path: string): boolean;containsIdentity?(stat:PathStat):boolean };
}
export const known = (s: string): Extract<Value,{k:'known'}> & MaySet => ({k:'known',s,values:[s],opaque:false,original:s});
export const opaque = (why: string): Extract<Value,{k:'opaque'}> & MaySet => ({k:'opaque',why,values:[],opaque:true});
