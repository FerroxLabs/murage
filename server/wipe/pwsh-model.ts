// SPDX-License-Identifier: AGPL-3.0-or-later
import { known, opaque, type Invocation, type Value, type WipeEffect } from './types.ts';
import { operand } from './expand.ts';
import { globRegExp, globValue, type GlobSpec, type GlobValue } from './glob.ts';

export interface Param {
 name: string;
 kind: 'path'|'literal'|'dest'|'newname'|'switch'|'value';
 pos?: number;
 pipe?: 'value'|'property';
 aliases?: string[];
}
export interface Cmdlet {
 name: string;
 aliases: string[];
 params: Param[];
 effect?: 'delete'|'move-away';
 recursive: 'flag'|'always';
 produces?: { emits: 'children'|'self'|'cwd'|'values'; defaultPath: '.'|null; recurseFlag?: string; filters: string[]; strings?: boolean };
 pass?: { endsOn: string[] };
}
const switches = (...names: string[]): Param[] => names.map(name => ({name,kind:'switch'}));
const values = (...names: string[]): Param[] => names.map(name => ({name,kind:'value'}));
const common: Param[] = [
 ...switches('Verbose','Debug','Confirm'),{name:'WhatIf',kind:'switch',aliases:['wi']},
 ...values('ErrorAction','ErrorVariable','WarningAction','WarningVariable','InformationAction','InformationVariable','OutVariable','OutBuffer','PipelineVariable','ProgressAction').map(parameter=>({...parameter,aliases:({ErrorAction:['ea'],ErrorVariable:['ev'],WarningAction:['wa'],WarningVariable:['wv'],InformationAction:['infa'],InformationVariable:['iv'],OutVariable:['ov'],OutBuffer:['ob'],PipelineVariable:['pv'],ProgressAction:['proga']} as Record<string,string[]>)[parameter.name]})),
];
const paths: Param[] = [{name:'Path',kind:'path',pos:0,pipe:'value'}, {name:'LiteralPath',kind:'literal',pipe:'property',aliases:['PSPath','LP']}];
const selection = values('Filter','Include','Exclude');
const filters = ['filter','include','exclude','name','attributes','depth'];
/** A single vocabulary feeds binding, consumers, producers and pass-through provenance. */
export const cmdlets: readonly Cmdlet[] = [
 {name:'Remove-Item',aliases:['ri','rm','del','erase','rd','rmdir'],params:[...paths,...switches('Recurse','Force'),...selection,...values('Credential','Stream'),...common],effect:'delete',recursive:'flag'},
 {name:'Move-Item',aliases:['mi','mv','move'],params:[...paths,{name:'Destination',kind:'dest',pos:1},...switches('Force','PassThru'),...selection,...values('Credential'),...common],effect:'move-away',recursive:'always'},
 {name:'Rename-Item',aliases:['rni','ren'],params:[...paths,{name:'NewName',kind:'newname',pos:1},...switches('Force','PassThru'),...values('Credential'),...common],effect:'move-away',recursive:'always'},
 {name:'Get-ChildItem',aliases:['gci','ls','dir'],params:[...paths,...switches('Recurse','Force','Name','Directory','File','Hidden','ReadOnly','System','FollowSymlink'),...selection.map(p=>p.name==='Filter'?{...p,pos:1}:p),...values('Depth','Attributes'),...common],recursive:'flag',produces:{emits:'children',defaultPath:'.',recurseFlag:'recurse',filters:[...filters,'hidden','readonly','system']}},
 {name:'Get-Item',aliases:['gi'],params:[...paths,...switches('Force'),...selection,...values('Credential','Stream'),...common],recursive:'flag',produces:{emits:'self',defaultPath:null,filters:['filter','include','exclude','stream']}},
 {name:'Resolve-Path',aliases:['rvpa'],params:[...paths,...switches('Relative','Force'),...values('RelativeBasePath','Credential'),...common],recursive:'flag',produces:{emits:'self',defaultPath:null,filters:['relative','relativebasepath']}},
 {name:'Convert-Path',aliases:['cvpa'],params:[...paths,...values('Credential'),...common],recursive:'flag',produces:{emits:'self',defaultPath:null,filters:[],strings:true}},
 {name:'Get-Location',aliases:['gl','pwd'],params:[...switches('Stack'),...values('PSDrive','PSProvider','StackName'),...common],recursive:'flag',produces:{emits:'cwd',defaultPath:null,filters:['stack','stackname','psdrive','psprovider']}},
 {name:'Sort-Object',aliases:['sort'],params:[{name:'Property',kind:'value',pos:0},...switches('Descending','Unique','Stable','CaseSensitive'),...values('Culture','Top','Bottom','InputObject'),...common],recursive:'flag',pass:{endsOn:['top','bottom']}},
 {name:'Tee-Object',aliases:['tee'],params:[{name:'FilePath',kind:'value',pos:0},...values('LiteralPath','Variable','InputObject','Encoding'),...switches('Append'),...common],recursive:'flag',pass:{endsOn:[]}},
 {name:'Write-Output',aliases:['echo','write'],params:[{name:'InputObject',kind:'path',pos:0,pipe:'value'},...switches('NoEnumerate'),...common],recursive:'flag',produces:{emits:'values',defaultPath:null,filters:[]},pass:{endsOn:[]}},
 {name:'Select-Object',aliases:['select'],params:[{name:'Property',kind:'value',pos:0},...values('First','Last','Skip','SkipLast','Index','SkipIndex','ExpandProperty','ExcludeProperty','InputObject'),...switches('Unique','Wait'),...common],recursive:'flag',pass:{endsOn:['first','last','skip','skiplast','index','skipindex']}},
 {name:'Where-Object',aliases:['where','?'],params:[...values('FilterScript','Property','Value'),...common],recursive:'flag'},
 {name:'ForEach-Object',aliases:['foreach','%'],params:[...values('Process','Begin','End','RemainingScripts','MemberName','ArgumentList','InputObject','Parallel','ThrottleLimit','TimeoutSeconds'),...switches('AsJob','UseNewRunspace'),...common],recursive:'flag'},
];
const names = new Map(cmdlets.flatMap(row => [row.name,...row.aliases].map(name => [name.toLowerCase(),row] as const)));
export function cmdletFor(name: string): Cmdlet|undefined {
 return names.get(name.replace(/^Microsoft\.PowerShell\.(?:Management|Utility)\\/i,'').toLowerCase());
}
export interface BoundParams {
 cmdlet?: Cmdlet;
 values: Map<string,Value[]>;
 flags: Set<string>;
 positionals: Value[];
 uncertain: boolean;
 unknown: Value[];
 consumed: Value[];
}
const text = (v: Value|undefined) => v?.k === 'known' ? v.s : undefined;
const splitValues = (v: Value): Value[] => v.k === 'known' && v.s.includes('\0,') ? v.s.split('\0,').map(s => ({...v,s})) : [v];
function add(bound: BoundParams, name: string, value: Value): void {
 const bucket=bound.values.get(name),parts=splitValues(value);
 if(bucket)for(const part of parts)bucket.push(part);else bound.values.set(name,parts);
}
/** PowerShell parameter names and their unambiguous prefixes are case insensitive. */
export function bindParams(inv: Invocation, cmdlet = cmdletFor(inv.program)): BoundParams {
 const bound: BoundParams = {cmdlet,values:new Map(),flags:new Set(),positionals:[],uncertain:false,unknown:[],consumed:[]};
 let stop = false;
 for (let i = 0; i < inv.argv.length; i++) {
  const value = inv.argv[i]!, expanded=text(value);
  const s=expanded?.startsWith('-')?(value as GlobValue).globText??expanded:expanded;
  if (!stop && s === '--') { stop = true; continue; }
  if (!stop && s?.startsWith('-') && s.length > 1) {
   const colon = s.indexOf(':'), spelling = s.slice(1,colon < 0 ? undefined : colon).toLowerCase();
   const parameters = cmdlet?.params??[];
   const exact = parameters.filter(p => [p.name,...(p.aliases??[])].some(name => name.toLowerCase() === spelling));
   const matches = exact.length ? exact : parameters.filter(p => p.name.toLowerCase().startsWith(spelling));
   if (matches.length !== 1) { bound.uncertain = true; bound.unknown.push(value); continue; }
   const parameter = matches[0]!, key = parameter.name.toLowerCase();
   bound.flags.add(key);
   if (parameter.kind === 'switch') {
    if (colon >= 0 && /^\$?false$/i.test(s.slice(colon+1))) bound.flags.delete(key);
    continue;
   }
   const next = inv.argv[i+1];
   if (colon < 0 && (!next || text(next)?.startsWith('-'))) { bound.uncertain = true; bound.unknown.push(value); continue; }
   const argument = colon >= 0 ? known(s.slice(colon+1)) : inv.argv[++i]!;
   add(bound,key,argument);bound.consumed.push(argument);
   continue;
  }
  bound.positionals.push(value);
  if (value.k === 'opaque') { bound.uncertain = true; bound.unknown.push(value); }
 }
 const positional = (cmdlet?.params??[]).filter(p => p.pos !== undefined).sort((a,b) => a.pos!-b.pos!);
 let at = 0;
 for (const parameter of positional) {
  const key = parameter.name.toLowerCase();
  if (bound.values.has(key) || parameter.kind === 'path' && bound.values.has('literalpath')) continue;
  const rest = positional.length === 1 || parameter === positional.at(-1) && parameter.kind === 'path';
  const operands = rest ? bound.positionals.slice(at) : bound.positionals.slice(at,at+1);
  if(operands.length)bound.flags.add(key);
  for (const value of operands) add(bound,key,value);
  at += operands.length;
 }
 // WIPE-V3-PREMISE ASKAPI-35 retains every visible Remove-Item source despite uncertain binding.
 if (cmdlet?.effect === 'delete' && at < bound.positionals.length) for (const value of bound.positionals.slice(at)) add(bound,'path',value);
 return bound;
}

function source(value: Value, inv: Invocation, literal = false, rawByValue?: Map<Value,string>): Value[] {
 if (value.k === 'opaque') return [value];
 const candidates = value.candidates??[value.s];
 return candidates.flatMap<Value>(s => {
  if (!literal && inv.home && /^~(?=[\\/]|$)/.test(s)) s = inv.home+s.slice(1);
  let model: GlobValue;
  if (value.entryOf || !literal && value.wholeDirGlob) model = {...value,s,candidates:undefined};
  else {
   // Preserve provider escapes where the parser has already removed the shell escape layer.
   const raw = rawByValue?.get(value);
   let pattern = (value as GlobValue).globText??raw?.replace(/^(['"])([\s\S]*)\1$/,'$2');
   if (!(value as GlobValue).globText && (!pattern?.includes('`') || pattern.replace(/`(.)/gs,'$1') !== s)) pattern = s;
   const {glob,wholeDirGlob,dirsOnly,...plain}=value;
   model = {...plain,...globValue(pattern??s,'pwsh',literal),candidates:undefined};
  }
  const absolute = operand(model,inv.cwd,inv);
  if (absolute.k === 'known' && absolute.glob) {
   const glob = absolute.glob as GlobSpec;
   return [{...absolute,glob:{...glob,base:glob.dir}}];
  }
  if(absolute.k==='known'){const {glob,...plain}=absolute;return [plain];}
  return [absolute];
 });
}
function rawArguments(inv:Invocation):Map<Value,string> {
 const rawByValue=new Map<Value,string>();
 for(let i=0;i<inv.argv.length;i++){const raw=inv.rawArgv[i]?.raw;if(raw!==undefined&&!rawByValue.has(inv.argv[i]!))rawByValue.set(inv.argv[i]!,raw);}
 return rawByValue;
}
function explicit(inv: Invocation, bound: BoundParams): Value[] {
 const params = bound.cmdlet?.params.filter(p => p.kind === 'path' || p.kind === 'literal')??[];
 const rawByValue=rawArguments(inv);
 return params.flatMap(p => (bound.values.get(p.name.toLowerCase())??[]).flatMap(value => source(value,inv,p.kind === 'literal',rawByValue)));
}
/** Sources are a union: adding -Path never erases a piped project or home. */
export function sourcesOf(inv: Invocation): Value[] {
 return [...explicit(inv,bindParams(inv)),...produced(inv.pipedFrom)];
}

/** The sole producer model; paths are absolute in the producer's provider cwd. */
export function produced(inv: Invocation|undefined): Value[] {
 const chain: Invocation[] = [], seen = new Set<Invocation>();
 while (inv && !seen.has(inv)) {
  seen.add(inv);chain.push(inv);inv=inv.pipedFrom;
 }
 let items:Value[]=[];
 // Property-bearing provider objects and path strings bind differently after Select-Object.
 const pathObjects=new Set<Value>();
 for(const stage of chain.reverse()) {
  if(stage.program==='\0values'){const raw=rawArguments(stage);items=stage.argv.flatMap(splitValues).flatMap(value=>source(value,stage,false,raw));continue;}
  const bound=bindParams(stage),row=bound.cmdlet;
  if (!row) {items=[];continue;}
  if (row.pass) {
   if (row.pass.endsOn.some(name => bound.flags.has(name))) {items=[];continue;}
   if (row.name === 'Select-Object') {
    const properties = bound.values.get('property');
    if(properties){
     if(!properties.some(v=>v.k==='known'&&globRegExp(v.s,'pwsh',true).test('PSPath'))){items=[];continue;}
     items=items.filter(value=>pathObjects.has(value));
    }
    if(bound.flags.has('expandproperty')){
     const property=bound.values.get('expandproperty');
     items=items.filter(value=>pathObjects.has(value)&&property?.some(v=>v.k==='known'&&v.s.toLowerCase()==='pspath'));
     for(const value of items)pathObjects.delete(value);
    }
    if (bound.flags.has('excludeproperty') && (bound.values.get('excludeproperty')??[]).some(v => v.k === 'known' && globRegExp(v.s,'pwsh',true).test('PSPath'))) {items=[];continue;}
   }
   if(row.produces?.emits==='values')items.push(...explicit(stage,bound));
   continue;
  }
  const producer = row.produces;
  if (!producer || producer.filters.some(name => bound.flags.has(name))) {items=[];continue;}
  let sources = [...explicit(stage,bound),...items];
  if (producer.emits === 'cwd') sources = source(stage.cwd,stage,true);
  else if (!sources.length && producer.defaultPath) sources = source(known(producer.defaultPath),stage);
  if (producer.emits === 'children') sources = sources.map(value => bound.flags.has('file') && !bound.flags.has(producer.recurseFlag??'') ? opaque('file-children') : value.k === 'known' ? {...value,wholeDirGlob:true,dirsOnly:bound.flags.has('directory') || value.dirsOnly,entryOf:{start:value.s,wholeTree:bound.flags.has(producer.recurseFlag??''),rootSelf:false}} : value);
  if(producer.emits!=='values'&&!producer.strings)for(const value of sources)pathObjects.add(value);
  items=sources;
 }
 return items;
}

/** Effects are ready for decide(); no consumer-specific producer recovery exists. */
export function pwshEffects(inv: Invocation): WipeEffect[] {
 if (inv.dialect !== 'pwsh') return [];
 const bound = bindParams(inv), row = bound.cmdlet;
 if (!row?.effect || bound.flags.has('whatif')) return [];
 const sources = sourcesOf(inv), effects: WipeEffect[] = [];
 for (const value of sources) {
  if (row.effect === 'move-away') effects.push({k:'move-away',source:value});
  else effects.push({k:'delete',target:value,recursive:bound.flags.has('recurse') || !!value.entryOf?.wholeTree || !!(value as GlobValue).recursiveGlob || value.k === 'known' && !!(value.glob as GlobSpec|undefined)?.segments.includes('**')});
 }
 // An unread option slot may supply recursion. Destination/newname/inert values never become sources.
 if (bound.uncertain && (row.recursive === 'always' || bound.flags.has('recurse') || bound.unknown.some(v => v.k === 'opaque' || v.k === 'known' && /^-r/i.test(v.s)))) effects.push({k:'uncertain-operands',program:row.name.toLowerCase(),words:sources});
 return effects;
}
