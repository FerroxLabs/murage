// SPDX-License-Identifier: AGPL-3.0-or-later
// Process state: what a shell process owns, and what crosses each kind of boundary.
//
// | Transition                                                   | Options                           | Variables                              | Functions                         |
// | same process: { }, function call, eval, trap, .              | shared                            | shared                                 | shared                            |
// | subshell: ( ), $( ), backticks, pipeline stage, &            | copied                            | copied                                 | copied                            |
// | new process: every host source, xargs / find -exec shells    | host defaults + its argv options  | exported values; others as             | exported ones, read as the        |
// |                                                              | (+ bash SHELLOPTS when exported)  | {parent value, UNSET}                  | function and as the real program  |
import type {ProcOpts,ShellState} from './types.ts';
import type {Host} from './hosts.ts';
export type {ProcOpts} from './types.ts';
export type Transition='same'|'subshell'|'new';
export function fork(st:ShellState,kind:Transition,host?:Host,opts:ProcOpts={}):ShellState {
 if(kind==='same')return st;
 const next:ShellState={...st,proc:{...st.proc},env:new Map(st.env),vars:new Map(st.vars),blocks:new Map(st.blocks),locals:st.locals?.slice(),arrays:new Map(st.arrays),functions:new Map(st.functions),links:new Map(st.links),dirStack:[...(st.dirStack??[])],positional:st.positional?.slice(),
  exported:st.exported&&new Set(st.exported),exportedFns:st.exportedFns&&new Set(st.exportedFns),inheritedFns:st.inheritedFns&&new Set(st.inheritedFns)};
 if(kind==='subshell')return next;
 const lang=host?.lang??'sh',posix=st.dialect==='sh'&&st.exported!==undefined;
 next.dialect=lang==='pwsh'?'pwsh':lang==='cmd'?'cmd':'sh';
 next.family=lang==='fish'?'fish':lang==='csh'?'csh':undefined;
 // bash hands its options to a child shell only through an exported SHELLOPTS; argv options then apply on top.
 const inherited=posix&&next.dialect==='sh'&&!next.family&&st.exported!.has('SHELLOPTS');
 next.proc={nounset:inherited&&!!st.proc?.nounset,errexit:inherited&&!!st.proc?.errexit,allexport:false,delayed:false,strict:false,...opts};
 next.locals=undefined;
 if(!posix)return next;
 // A value that was not exported is unset in the child. Both readings are kept: the parent's value and UNSET.
 for(const [name,may] of st.vars??[])if(!st.exported!.has(name))next.vars!.set(name,{...may,maybeUnset:true});
 next.arrays=new Map();
 // Only exported functions cross, and the name is also read as the real program.
 next.functions=new Map([...(st.functions??[])].filter(([name])=>st.exportedFns?.has(name)));
 next.inheritedFns=new Set(next.functions.keys());
 return next;
}
export type UnsetPolicy='empty'|'abort'|'drop-word'|'literal';
/**
 * What an unset variable does, per host family.
 * sh-family with nounset off: expands empty. With nounset on: the process aborts (`${x-}`, `${x:-}`, `$@`, `$*` are exempt).
 * csh / tcsh: always aborts. fish: an unquoted word holding it expands to zero words. PowerShell: empty (StrictMode is
 * not modelled). cmd: `%X%` stays literal. With no engine environment at all nounset counts as off.
 */
export function unsetPolicy(st:ShellState):UnsetPolicy {
 if(st.dialect==='cmd')return 'literal';
 if(st.dialect!=='sh')return 'empty';
 if(st.family==='csh')return 'abort';
 if(st.family==='fish')return 'drop-word';
 return st.proc?.nounset&&!st.noEnv?'abort':'empty';
}
