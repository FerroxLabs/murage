// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: sc-safety (integrity). Production classes own authority methods.
import { afterEach, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
type Baseline={value:object;prototype:object|null;frozen:boolean;descriptors:Map<PropertyKey,PropertyDescriptor>;entries:Array<[PropertyKey,PropertyDescriptor,boolean]>;name:string};
const tracked:Baseline[]=[];
export interface PortScope { readonly _opaquePortScope?: never }
const scopes=new AsyncLocalStorage<PortScope>();
const scopeGet=AsyncLocalStorage.prototype.getStore,scopeRun=AsyncLocalStorage.prototype.run,scopeExit=AsyncLocalStorage.prototype.exit;
const scopeRows=new WeakMap<PortScope,Set<Baseline>>();
export const currentPortScope=():PortScope|undefined=>scopeGet.call(scopes);
/** Each retained binding checks its own instance records. Shared prototypes
 * always check globally; afterEach still checks every record from every bind. */
export function withinPortScope<T>(work:()=>T,scope:PortScope|undefined=currentPortScope()):T {
  if(!scope){scope=Object.freeze(Object.create(null)) as PortScope;weakSet.call(scopeRows,scope,new Set());}
  if(!weakGet.call(scopeRows,scope))throw new Error("FIXTURE_PORT_SCOPE_REFUSED");
  return scopeRun.call(scopes,scope,work) as T;
}
const getDescriptor=Object.getOwnPropertyDescriptor,getPrototype=Object.getPrototypeOf,isFrozen=Object.isFrozen,ownKeys=Reflect.ownKeys;
const weakGet=WeakMap.prototype.get,weakSet=WeakMap.prototype.set,mapGet=Map.prototype.get;
let snapshots=new WeakMap<object,Baseline>();
const pristineValues=new WeakSet<object>();
function baseline(value:object,name:string):Baseline {
  const entries=ownKeys(value).map(key=>{const descriptor=getDescriptor(value,key)!;return [key,descriptor,typeof descriptor.value==="function"||!!descriptor.get||!!descriptor.set] as [PropertyKey,PropertyDescriptor,boolean];});
  return {value,name,prototype:getPrototype(value),frozen:isFrozen(value),descriptors:new Map(entries.map(([key,descriptor])=>[key,descriptor])),entries};
}
// Captured before case hooks run. A preflight patch cannot redefine "fresh".
const pristine=[Map.prototype,Set.prototype,WeakMap.prototype,WeakSet.prototype,Object.prototype,Array.prototype,Function.prototype,getPrototype(async()=>{}),getPrototype(function*(){}),getPrototype(async function*(){})].map(value=>baseline(value,"shared prototype"));
const sharedPristine=[...pristine];
for(const row of pristine){weakSet.call(snapshots,row.value,row);pristineValues.add(row.value);}
// Built-in superclass constructors are also prototype edges of imported
// subclasses (for example a production refusal extends Error). Capture them
// before hooks, just like the shared collection and function prototypes.
for (const Constructor of [Error,TypeError,RangeError,SyntaxError,ReferenceError,URIError,EvalError,AggregateError,Promise,Date,RegExp,URL,URLSearchParams]) registerPortConstructor(Constructor);
export function registerPortConstructor(Constructor:Function,lifetime:"module"|"binding"="module"):void {
  for (const root of [Constructor,getDescriptor(Constructor,"prototype")?.value]) {
    for(let value=root;value;value=getPrototype(value)) {
      if(weakGet.call(snapshots,value)){if(lifetime==="binding")remember(value,`${Constructor.name}.constructor`);continue;}
      if(lifetime==="binding")remember(value,`${Constructor.name}.constructor`);
      else {
        const row=baseline(value,`${Constructor.name}.constructor`);pristine.push(row);weakSet.call(snapshots,value,row);pristineValues.add(value);
      }
    }
  }
}
/** Module-initialization admission for real exported singletons. Retain this
 * baseline across cases so an own-method patch cannot become a first snapshot. */
export function registerPortSingleton(name:string,value:object):void {
  const prototype=getPrototype(value),Constructor=prototype&&getDescriptor(prototype,"constructor")?.value;
  if(typeof Constructor==="function")registerPortConstructor(Constructor);
  if(!weakGet.call(snapshots,value)) {
    const row=baseline(value,`${name}.singleton`);pristine.push(row);weakSet.call(snapshots,value,row);pristineValues.add(value);
  }
}
function remember(value:object,name:string):void {
  let row=weakGet.call(snapshots,value) as Baseline|undefined;
  if(!row){row=baseline(value,name);weakSet.call(snapshots,value,row);tracked.push(row);}
  const scope=currentPortScope();
  if(scope&&!pristineValues.has(value))(weakGet.call(scopeRows,scope) as Set<Baseline>).add(row);
}
const collectionTypes=[Map,Set,WeakMap,WeakSet];
export function trackPort(name:string,value:unknown,requireRegistered=false):void {
  if(!value||typeof value!=="object"&&typeof value!=="function")return;
  const prototype = getPrototype(value);
  if(requireRegistered && prototype && !weakGet.call(snapshots,prototype))throw new Error(`FIXTURE_PORT_UNREGISTERED ${name}`);
  const instancePrototype=typeof value==="function"&&getDescriptor(value,"prototype")?.value;
  if(requireRegistered&&instancePrototype&&/^class\b/.test(Function.prototype.toString.call(value))&&!weakGet.call(snapshots,instancePrototype))throw new Error(`FIXTURE_PORT_UNREGISTERED ${name}.prototype`);
  for(const Constructor of collectionTypes)if(value instanceof Constructor) {
    const prototype=getPrototype(value),owner=prototype&&getDescriptor(prototype,"constructor")?.value;
    if(typeof owner!=="function"||owner.prototype!==prototype||ownKeys(value).some(key=>{
      const descriptor=getDescriptor(value,key)!;
      return (typeof descriptor.value==="function"||!!descriptor.get||!!descriptor.set)
        &&typeof getDescriptor(Constructor.prototype,key)?.value==="function";
    }))throw new Error(`FIXTURE_PORT_TAMPERED ${name}`);
  }
  remember(value,name);
  for(let prototype=getPrototype(value);prototype;prototype=getPrototype(prototype))remember(prototype,`${name}.prototype`);
  if(typeof value==="function") {
    const prototype=getDescriptor(value,"prototype")?.value;
    if(prototype&&typeof prototype==="object")remember(prototype,`${name}.constructor.prototype`);
  }
}
function check(row:Baseline):void {
  if(getPrototype(row.value)!==row.prototype||isFrozen(row.value)!==row.frozen)throw new Error(`FIXTURE_PORT_TAMPERED ${row.name}`);
  // A still-frozen object with the same prototype cannot add, remove or
  // redefine an own descriptor. Its separately tracked prototype still checks.
  if(row.frozen)return;
  const keys=ownKeys(row.value);
  let sameShape=keys.length===row.entries.length;
  for(let index=0;index<row.entries.length;index++) {
    const [key,before,wasExecutable]=row.entries[index],after=getDescriptor(row.value,key);
    sameShape= sameShape && keys[index]===key;
    if((wasExecutable||!!after&&(typeof after.value==="function"||!!after.get||!!after.set))&&(!after||before.value!==after.value||before.get!==after.get||before.set!==after.set
      ||before.writable!==after.writable||before.configurable!==after.configurable||before.enumerable!==after.enumerable))throw new Error(`FIXTURE_PORT_TAMPERED ${row.name}.${String(key)}`);
  }
  // New data keys are allowed, new executable keys are never allowed. The
  // common unchanged-key path needs no temporary Set or descriptor-map reads.
  if(!sameShape)for(const key of keys)if(!mapGet.call(row.descriptors,key)) {
    const after=getDescriptor(row.value,key)!;
    if(typeof after.value==="function"||after.get||after.set)throw new Error(`FIXTURE_PORT_TAMPERED ${row.name}.${String(key)}`);
  }
}
const observers:Array<{name:string;implementation:()=>unknown;real:unknown;scope:PortScope|undefined}>=[];
const observedImplementations=new WeakMap<Function,unknown>();
export function isPortObserver(value:unknown,real:unknown):boolean {
  return typeof value==="function"&&typeof real==="function"&&weakGet.call(observedImplementations,value)===real;
}
const observerRestores:Array<()=>void>=[];
export function assertPortsPristine():void {
  for(const row of pristine)check(row);
  const scope=currentPortScope();
  for(const row of scope?weakGet.call(scopeRows,scope) as Set<Baseline>:tracked)check(row);
  for(const row of observers)if((!scope||!row.scope||row.scope===scope)&&row.implementation()!==row.real)throw new Error(`FIXTURE_PORT_TAMPERED ${row.name}.implementation`);
}
/** A method lookup checks its object and shared prototypes; the complete
 * registry is checked at entry/exit and afterEach. Avoid a registry-wide scan
 * for every Map.get in the extracted server. */
function assertLocal(value:object):void {
  for(const row of sharedPristine)check(row);
  for(let object:object|null=value;object;object=getPrototype(object)) {
    const row=weakGet.call(snapshots,object);if(row)check(row);
  }
}
/** Lock mutation APIs as well as checking the current implementation: a queued
 * mockImplementationOnce must not run substituted authority between checks. */
let admittedObservers=new WeakMap<Function,{real:Function;guarded:(...args:unknown[])=>unknown}>();
export function observePort(name:string,value:unknown,real:unknown):(...args:unknown[])=>unknown {
  if(typeof value!=="function"||typeof real!=="function"||!vi.isMockFunction(value)||value.getMockImplementation()!==real)throw new Error(`FIXTURE_OVERRIDE_REFUSED ${name}`);
  const withImplementation=value.withImplementation.bind(value),implementation=value.getMockImplementation.bind(value);
  const previous=admittedObservers.get(value);
  if(previous) {
    if(previous.real!==real)throw new Error(`FIXTURE_OVERRIDE_REFUSED ${name}`);
    observers.push({name,implementation,real,scope:currentPortScope()});trackPort(name,value);
    return previous.guarded;
  }
  observers.push({name,implementation,real,scope:currentPortScope()});
  const originals=new Map<string,PropertyDescriptor>();
  for(const key of ["mockImplementation","mockImplementationOnce","mockReturnValue","mockReturnValueOnce","mockResolvedValue","mockResolvedValueOnce","mockRejectedValue","mockRejectedValueOnce","withImplementation","mockReset","mockRestore"]) {
    originals.set(key,Object.getOwnPropertyDescriptor(value,key)!);
    Object.defineProperty(value,key,{value:()=>{throw new Error(`FIXTURE_PORT_TAMPERED ${name}.${key}`);},configurable:true,writable:false});
  }
  observerRestores.push(()=>{for(const [key,descriptor]of originals)Object.defineProperty(value,key,descriptor);});
  trackPort(name,value);
  const guarded=function(this:unknown,...args:unknown[]) {
    assertPortsPristine();
    let result:unknown;
    if(implementation()!==real)throw new Error(`FIXTURE_PORT_TAMPERED ${name}.implementation`);
    // Vitest's temporary implementation ignores queued one-shot replacements.
    withImplementation(real as (...args:unknown[])=>unknown,()=>{result=Reflect.apply(value,this,args);});
    assertPortsPristine();return result;
  };
  weakSet.call(observedImplementations,guarded,real);admittedObservers.set(value,{real,guarded});return guarded;
}
afterEach(()=>{try{scopeExit.call(scopes,()=>assertPortsPristine());}finally{for(const restore of observerRestores.splice(0))restore();tracked.length=0;observers.length=0;admittedObservers=new WeakMap();snapshots=new WeakMap();for(const row of pristine)weakSet.call(snapshots,row.value,row);}});

const protectedPorts=new WeakMap<object,object>();
/** Keep method lookup inside integrity admission as well. A patch restored by
 * an I/O callback cannot run a substituted authority method between checks. */
export function protectPort<T>(value:T):T {
  if(!value||typeof value!=="object")return value;
  const prior=protectedPorts.get(value);if(prior)return prior as T;
  const methods=new Map<PropertyKey,{original:Function;guarded:Function}>();
  const guarded=new Proxy(value,{
    get(target,key) {
      assertLocal(target);
      const result=Reflect.get(target,key,target);
      if(typeof result!=="function")return result;
      const descriptor=Reflect.getOwnPropertyDescriptor(target,key);
      if(descriptor&&!descriptor.configurable&&"value"in descriptor&&!descriptor.writable)return result;
      const prior=methods.get(key);if(prior?.original===result)return prior.guarded;
      const checked=function(...args:unknown[]){assertLocal(target);const output=Reflect.apply(result,target,args);assertLocal(target);return output;};
      methods.set(key,{original:result,guarded:checked});return checked;
    },
    set(target,key,input) {if(typeof input==="function")throw new Error(`FIXTURE_PORT_TAMPERED ${String(key)}`);return Reflect.set(target,key,input,target);},
    defineProperty(target,key,descriptor) {if(typeof descriptor.value==="function"||descriptor.get||descriptor.set)throw new Error(`FIXTURE_PORT_TAMPERED ${String(key)}`);return Reflect.defineProperty(target,key,descriptor);},
    setPrototypeOf(){throw new Error("FIXTURE_PORT_TAMPERED prototype");},
    preventExtensions(){throw new Error("FIXTURE_PORT_TAMPERED frozen");},
  });
  protectedPorts.set(value,guarded);return guarded;
}
