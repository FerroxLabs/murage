// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: sc-safety (extraction); callers own their explicit I/O fixtures.
import ts from "typescript";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { containImport } from "./import-containment.ts";
import { resolveCaseDeclaration, casePortFor, checkCasePort, overrideRefused, declarationKey, type DeclarationId } from "./case-ports.ts";
import { trackPort, assertPortsPristine, observePort, protectPort, withinPortScope, currentPortScope } from "./port-integrity.ts";
import "./production-port-catalog.ts";

const extractedOrigins = new WeakMap<Function,{declaration:DeclarationId;owner?:object}>();
const returnedReferences=new Map<string,Map<string,string>>();
function canonicalReturnedReferences(expression:string):Map<string,string> {
  const cached=returnedReferences.get(expression);if(cached)return cached;
  const source=ts.createSourceFile("returned.ts",`const selected = (${expression});`,ts.ScriptTarget.Latest,true);
  const host=ts.createCompilerHost({noLib:true,noResolve:true});host.getSourceFile=name=>name==="returned.ts"?source:undefined;
  const checker=ts.createProgram(["returned.ts"],{noLib:true,noResolve:true},host).getTypeChecker();
  const unwrap=(node:ts.Expression):ts.Expression=>ts.isParenthesizedExpression(node)?unwrap(node.expression):node;
  const declaration=source.statements[0];
  if(!ts.isVariableStatement(declaration))throw new Error("FIXTURE_SELECTION_INVALID");
  let result=unwrap(declaration.declarationList.declarations[0].initializer!);
  if(ts.isCallExpression(result)) {
    const callee=unwrap(result.expression);
    if(ts.isArrowFunction(callee)&&ts.isBlock(callee.body)) {
      const last=callee.body.statements.at(-1);let early=false;
      const visit=(node:ts.Node):void=>{if(node!==callee.body&&ts.isFunctionLike(node))return;if(ts.isReturnStatement(node)&&node!==last)early=true;ts.forEachChild(node,visit);};visit(callee.body);
      if(!early&&last&&ts.isReturnStatement(last)&&last.expression)result=unwrap(last.expression);
    }
  }
  const references=new Map<string,string>();
  if(ts.isObjectLiteralExpression(result))for(const property of result.properties) {
    const reference=ts.isShorthandPropertyAssignment(property)?property.name:ts.isPropertyAssignment(property)&&ts.isIdentifier(property.initializer)?property.initializer:undefined;
    if(!reference||!property.name)continue;
    const symbol=ts.isShorthandPropertyAssignment(property)?checker.getShorthandAssignmentValueSymbol(property):checker.getSymbolAtLocation(reference);
    if(symbol?.declarations?.length)continue; // A local shadow never proves module origin.
    const name=ts.isStringLiteral(property.name)?property.name.text:property.name.getText(source);
    references.set(name,reference.text);
  }
  if(returnedReferences.size>128)returnedReferences.clear();returnedReferences.set(expression,references);return references;
}
export function isExtractedFunctionFor(value:unknown,declaration:DeclarationId,owner?:object,ownerBound=false):boolean {
  const origin=typeof value==="function"?extractedOrigins.get(value):undefined;
  return !!origin && declarationKey(origin.declaration)===declarationKey(declaration)&&(!ownerBound||!!owner&&origin.owner===owner);
}

export type Resolution = { step: "case" | "state" | "declaration" | "import" | "global"; line: number; value?: unknown };
export interface StatePort { name: string; fresh: () => unknown; reason: string; defer?:boolean; current?: () => unknown; update?: (value: unknown) => void }
export interface ExtractionOptions {
  file: string | URL;
  text?: string;
  /** A function expression, or the name of a declaration to extract. */
  select: string | ((source: ts.SourceFile) => ts.Node | string);
  include?: string[];
}
export interface BindOptions {
  ports?: readonly StatePort[];
}
export const FIXTURE_GLOBALS: Record<string, unknown> = {
  undefined, Infinity, NaN, Buffer, URL, URLSearchParams, JSON, Object, Array, String, Number, Boolean, Math, Date,
  Set, Map, WeakMap, WeakSet, Promise, Error, TypeError, RangeError, SyntaxError, AggregateError, RegExp, AbortController,
  Intl, performance, BigInt, parseInt, parseFloat, isNaN, isFinite, encodeURI, decodeURI, DOMException,
  ArrayBuffer, DataView, Uint16Array, Uint32Array, Int32Array, atob, btoa, globalThis,
  setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, AbortSignal,
  encodeURIComponent, decodeURIComponent, console, process, Uint8Array, Symbol, Reflect, structuredClone, fetch, Headers, Request, Response, TextEncoder, TextDecoder, queueMicrotask,
};
export const IMPORT_PORTS = new Set(["./index.ts", "../index.ts"]);
function admitCaseOverride(source: ts.SourceFile, name: string) {
  const declaration = resolveCaseDeclaration(source,name);
  const port = casePortFor(declaration);
  if (!port) throw overrideRefused(name,declaration,source);
  return port;
}

const erasedUnits = new Map<string, string>();
function erase(text: string,dynamicImports=false): string {
  const key=(dynamicImports?"dynamic\0":"plain\0")+text;
  const cached = erasedUnits.get(key); if (cached !== undefined) return cached;
  const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.None, alwaysStrict: false },
    ...(dynamicImports?{transformers:{before:[context=>source=>{
      const visit:ts.Visitor=node=>ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword
        ?ts.factory.updateCallExpression(node,ts.factory.createIdentifier("__fixtureDynamicImport"),undefined,node.arguments)
        :ts.visitEachChild(node,visit,context);
      return ts.visitNode(source,visit) as ts.SourceFile;
    }]}}:{}),
  }).outputText;
  if (erasedUnits.size > 512) erasedUnits.clear();
  erasedUnits.set(key, output); return output;
}
/** Binder-based free variables, including shorthand values and nested closures. */
const freeCache = new Map<string, Set<string>>();
export function freeNames(text: string): Set<string> {
  const cached = freeCache.get(text); if (cached) return cached;
  const source = ts.createSourceFile("unit.js", erase(text), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const host = ts.createCompilerHost({ noLib: true, allowJs: true });
  host.getSourceFile = name => name === "unit.js" ? source : undefined;
  const checker = ts.createProgram(["unit.js"], { noLib: true, allowJs: true }, host).getTypeChecker();
  const free = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const property = ts.isPropertyAccessExpression(p) && p.name === node
        || (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === node
        || ts.isBindingElement(p) && p.propertyName === node
        || ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p);
      const symbol = ts.isShorthandPropertyAssignment(p) ? checker.getShorthandAssignmentValueSymbol(p) : checker.getSymbolAtLocation(node);
      if (!property && !symbol?.declarations?.length) free.add(node.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(source); if (freeCache.size > 8192) freeCache.clear(); freeCache.set(text,free); return free;
}

// Proofs belong to the actual fixture factories; copied records cannot carry
// them. Imports are deferred so the schema-only index-port bootstrap has no cycle.
let statePortAdmission: ((port: StatePort) => boolean) | undefined;
let statePortOwner: ((port:StatePort)=>object|undefined)|undefined;
let statePortAdmissionLoading: Promise<void> | undefined;
export async function preloadStatePortAdmission(): Promise<void> {
  await (statePortAdmissionLoading ??= Promise.all([import("./index-ports.ts"),import("./internal-authority-fixture.ts")]).then(([index,authority])=>{
    statePortOwner=authority.internalStatePortOwner;
    statePortAdmission = port => index.isIndexStatePort(port) || authority.isInternalStatePort(port);
  }));
}

// Serialize guarded imports: restoring a concurrent guard must not open a gap.
let importTail: Promise<unknown> = Promise.resolve();
const realImports = new Map<string, Record<string, unknown>>();
async function guardedImport(specifier: string): Promise<Record<string, unknown>> {
  const target=isAbsolute(specifier)?pathToFileURL(specifier):specifier.startsWith("file:")?new URL(specifier):undefined;
  if(target&&fileURLToPath(target)===fileURLToPath(new URL("../index.ts",import.meta.url)))throw new Error("FIXTURE_IMPORT_PORT_REQUIRED index.ts");
  const cached = realImports.get(specifier); if (cached) return cached;
  const result = importTail.then(async () => {
    const module = await containImport(process.env.MURAGE_FIXTURE_IMPORT_ROOT ?? process.env.HOME!, () => import(/* @vite-ignore */ specifier));
    realImports.set(specifier, module);
    return module;
  });
  importTail = result.catch(() => undefined);
  return result;
}

type SourceMetadata = { source: ts.SourceFile;
  declarations: Map<string, ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableDeclaration>;
  state: Map<string, ts.VariableDeclaration>; imports: Map<string, {specifier: string; exported: string}>; lines:Map<string,number> };
// Cache executable text only, never a scope value or policy result. Include
// inode and nanosecond ctime as well as mtime: restoring an old mtime after a
// same-size edit cannot retain an earlier production declaration.
const sourceTexts=new Map<string,{fingerprint:string;text:string}>();
export function currentSourceText(file:string):string|undefined {
  let stat:import("node:fs").BigIntStats;
  try {stat=statSync(file,{bigint:true});}
  catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;sourceTexts.delete(file);return;}
  const fingerprint=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(":");
  const cached=sourceTexts.get(file);if(cached?.fingerprint===fingerprint)return cached.text;
  const text=readFileSync(file,"utf8");sourceTexts.set(file,{fingerprint,text});return text;
}
const sourceMetadata = new Map<string, Map<string,SourceMetadata>>();
let sourceMetadataCount=0;
type ClosurePlan={actions:Array<{name:string;step:Resolution["step"];line:number}>;external:readonly string[];code:string;configured?: (scope:Record<string,unknown>)=>any};
const closurePlans=new WeakMap<ts.SourceFile,Map<string,Map<string,ClosurePlan>>>();
const functionOrigins=new WeakMap<ts.SourceFile,Map<string,string>>();
function metadata(file: string, text: string): SourceMetadata {
  const cached = sourceMetadata.get(file)?.get(text); if (cached) return cached;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableDeclaration>();
  const state = new Map<string, ts.VariableDeclaration>();
  const imports = new Map<string, { specifier: string; exported: string }>();
  for (const node of source.statements) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) declarations.set(node.name.text, node);
    if (ts.isVariableStatement(node)) for (const decl of node.declarationList.declarations) if (ts.isIdentifier(decl.name)) {
      // A function expression is code, not module state. Merely define it;
      // never evaluate arbitrary module initializers or singleton factories.
      if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer) || ts.isIdentifier(decl.initializer) || ts.isPropertyAccessExpression(decl.initializer))) declarations.set(decl.name.text, decl);
      else state.set(decl.name.text, decl);
    }
    if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text, clause = node.importClause;
      if (clause.name) imports.set(clause.name.text, { specifier, exported: "default" });
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) imports.set(clause.namedBindings.name.text, { specifier, exported: "*" });
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) if (!item.isTypeOnly) imports.set(item.name.text, { specifier, exported: item.propertyName?.text ?? item.name.text });
    }
  }
  const result = {source,declarations,state,imports,lines:new Map<string,number>()};
  if (sourceMetadataCount > 32) {sourceMetadata.clear();sourceMetadataCount=0;}
  let texts=sourceMetadata.get(file);if(!texts){texts=new Map();sourceMetadata.set(file,texts);}
  texts.set(text,result);sourceMetadataCount++;return result;
}

/** Prepare parser/binder metadata only. Never imports or evaluates the file. */
export function preloadDeclarationAnalysis(input:string|URL):void {
  const file=input instanceof URL?fileURLToPath(input):resolve(input);
  const {source,declarations}=metadata(file,readFileSync(file,"utf8"));
  for(const node of declarations.values())freeNames(ts.isVariableDeclaration(node)?`const ${node.getText(source)};`:node.getText(source));
}

export function extractFunction(options: ExtractionOptions) {
  const file = options.file instanceof URL ? fileURLToPath(options.file) : resolve(options.file);
  const actualText=currentSourceText(file);
  const { source, declarations, state, imports, lines } = metadata(file,options.text ?? actualText ?? readFileSync(file,"utf8"));
  const selected = typeof options.select === "function" ? options.select(source) : declarations.get(options.select) ?? state.get(options.select)?.initializer;
  if (!selected) throw new Error(`FIXTURE_SELECTION_MISSING ${String(options.select)}`);
  const expression = typeof selected === "string" ? selected : ts.isVariableDeclaration(selected) ? selected.initializer!.getText(source) : selected.getText(source);
  const productionSource = actualText!==undefined && source.text === actualText;
  let origins=functionOrigins.get(source);
  if(productionSource&&!origins) {
    origins=new Map();
    for(const [name,node]of declarations) {
      const value=ts.isVariableDeclaration(node)?node.initializer:node;
      if(value&&(ts.isFunctionDeclaration(value)||ts.isArrowFunction(value)||ts.isFunctionExpression(value))) {
        const text=value.getText(source);if(!origins.has(text))origins.set(text,name);
      }
    }
    functionOrigins.set(source,origins);
  }
  const originName=productionSource&&origins?.get(expression);
  const originId = originName ? resolveCaseDeclaration(source,originName) : undefined;
  const optionsInclude=()=>[...(options.include??[])];
  const free = new Map<string, Resolution>();
  function line(name: string) { const known=lines.get(name);if(known!==undefined)return known;const node = declarations.get(name) ?? state.get(name);const value=source.getLineAndCharacterOfPosition(node?.getStart(source) ?? Math.max(0, source.text.indexOf(name))).line + 1;lines.set(name,value);return value; }
  function closure(scope: Record<string, unknown>, ports: Pick<Map<string, unknown>, "has" | "get">, owner?:object) {
    const needed = new Map<string, ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableDeclaration>();
    const pending = [...freeNames(`const extracted = (${expression});`), ...(options.include ?? [])];
    const external = new Set<string>();
    while (pending.length) {
      const name = pending.shift()!;
      if (needed.has(name) || external.has(name)) continue;
      const decl = declarations.get(name);
      if (Object.hasOwn(scope, name)) {
        // Imports are compared to their real export after guarded resolution.
        // Every replacement, including constants and state names, needs a port.
        const port = admitCaseOverride(source,name);
        if (!imports.has(name)) {
          checkCasePort(port,scope[name],undefined,()=>overrideRefused(name,resolveCaseDeclaration(source,name),source),owner);
        }
        external.add(name); free.set(name, { step: "case", line: line(name), value: scope[name] }); continue;
      }
      if (ports.has(name)) {
        if (declarations.has(name) || imports.has(name)) throw overrideRefused(name,resolveCaseDeclaration(source,name),source);
        ports.get(name); external.add(name); free.set(name, { step: "state", line: line(name),  }); continue; }
      if (decl) {
        needed.set(name, decl); free.set(name, { step: "declaration", line: line(name) });
        pending.push(...freeNames(ts.isVariableDeclaration(decl) ? `const ${decl.getText(source)};` : decl.getText(source))); continue;
      }
      external.add(name);
      free.set(name, { step: imports.has(name) ? "import" : "global", line: line(name) });
    }
    return { needed: [...needed.values()].sort((a,b) => a.pos-b.pos).map(node => ts.isVariableDeclaration(node) ? `const ${node.getText(source)};` : node.getText(source).replace(/^export\s+(?:default\s+)?/, "")).join("\n"), external };
  }
  function prepare(scope: Record<string, unknown>, options: BindOptions) {
    assertPortsPristine();
    free.clear();
    for(const name of Object.keys(scope))admitCaseOverride(source,name);
    const definitions = new Map((options.ports ?? []).map(port => [port.name, port]));
    const owners=new Set([...definitions.values()].map(port=>statePortOwner?.(port)).filter((owner):owner is object=>!!owner));
    if(owners.size>1)throw new Error("FIXTURE_STATE_OWNER_MISMATCH");
    const owner=[...owners][0];
    const ports = new Map<string, unknown>(),deferred=Object.freeze(Object.create(null));
    const realize=(name:string):unknown=>{
      const definition=definitions.get(name)!,data=casePortFor(resolveCaseDeclaration(source,name));
      const value=definition.fresh(),initializer=state.get(name)?.initializer;
      if(productionSource&&!statePortAdmission?.(definition)&&data)checkCasePort(data,value,undefined,()=>overrideRefused(name,resolveCaseDeclaration(source,name),source));
      if(initializer&&ts.isNewExpression(initializer)&&ts.isIdentifier(initializer.expression)
        &&["Map","Set","WeakMap","WeakSet"].includes(initializer.expression.text)&&!declarations.has(initializer.expression.text)&&!imports.has(initializer.expression.text)) {
        const Constructor=FIXTURE_GLOBALS[initializer.expression.text] as {prototype:object};
        if(!value||typeof value!=="object"||Object.getPrototypeOf(value)!==Constructor.prototype)throw new Error(`FIXTURE_PORT_TAMPERED ${name}`);
      }
      trackPort(name,value,productionSource);return value;
    };
    const lazyPorts={has:(name:string)=>definitions.has(name),get(name:string) {
      if(!ports.has(name)) {
        const definition=definitions.get(name)!,data=casePortFor(resolveCaseDeclaration(source,name));
        if(productionSource&&!statePortAdmission?.(definition)&&data?.category!=="DATA")throw new Error(`FIXTURE_STATE_PORT_REFUSED ${name}:${line(name)}`);
        // Only branded factory recipes may defer production realization.
        // Arbitrary/copied ports are refused above before any fresh() call.
        ports.set(name,definition.defer&&(!productionSource||statePortAdmission?.(definition))?deferred:realize(name));
      }
      return ports.get(name);
    }};
    // The plan contains names and immutable executable code only. Admission
    // still checks every current scope value and every current port recipe.
    let expressions=closurePlans.get(source);if(!expressions){expressions=new Map();closurePlans.set(source,expressions);}
    let signatures=expressions.get(expression);if(!signatures){signatures=new Map();if(expressions.size>128)expressions.clear();expressions.set(expression,signatures);}
    const signature=JSON.stringify([Object.keys(scope).sort(),[...definitions.keys()].sort(),optionsInclude()]);
    let plan=signatures.get(signature);
    if(plan) {
      for(const action of plan.actions) {
        const {name,step}=action;
        if(step==="case") {
          const port=admitCaseOverride(source,name);
          if(!imports.has(name))checkCasePort(port,scope[name],undefined,()=>overrideRefused(name,resolveCaseDeclaration(source,name),source),owner);
        } else if(step==="state") {
          if(declarations.has(name)||imports.has(name))throw overrideRefused(name,resolveCaseDeclaration(source,name),source);
          lazyPorts.get(name);
        }
        free.set(name,{step,line:action.line,...(step==="case"?{value:scope[name]}:{})});
      }
    } else {
      const result=closure(scope,lazyPorts,owner);
      plan={actions:[...free].map(([name,row])=>({name,step:row.step,line:row.line})),external:[...result.external],code:erase(`function configured(scope) { with(scope) { ${result.needed}\nreturn (${expression}); } }`,true)};
      if(signatures.size>128)signatures.clear();signatures.set(signature,plan);
    }
    const external=new Set(plan.external);
    const bound = Object.assign(Object.create(null), FIXTURE_GLOBALS, scope);
    for(const [name,resolution]of free)if(resolution.step==="case"&&casePortFor(resolveCaseDeclaration(source,name))?.category==="DATA") {
      trackPort(name,bound[name],productionSource);bound[name]=protectPort(bound[name]);
    }
    for(const [name,resolution]of free)if(resolution.step==="case"&&!imports.has(name)&&casePortFor(resolveCaseDeclaration(source,name))?.category==="OBSERVER") {
      const observer=bound[name];
      bound[name]=observePort(name,observer,(observer as {getMockImplementation():unknown}).getMockImplementation());
    }
    for(const [name,initial] of ports) {
      const port=definitions.get(name)!;let retained=initial;
      Object.defineProperty(bound,name,{enumerable:true,configurable:false,
        get(){if(retained===deferred)retained=realize(name);const value=port.current?port.current():retained;if(value!==retained){trackPort(name,value,productionSource);retained=value;}return protectPort(value);},
        set(value){retained=value;port.update?.(value);},
      });
    }
    return { bound, external, code:plan.code, plan, ports, owner };
  }
  function unresolved(names: string[]): never {
    throw new Error(`FIXTURE_SCOPE_UNRESOLVED ${names.map(name => `${name}:${line(name)} (step ${state.has(name) ? "2 state port" : imports.has(name) ? "4 import" : "1 case scope"})`).join(", ")}`);
  }
  function finish(prepared: ReturnType<typeof prepare>) {
    assertPortsPristine();
    const missing = [...prepared.external].filter(name => !Object.hasOwn(prepared.bound, name));
    if (missing.length) unresolved(missing);
    let configured=prepared.plan.configured;
    if(!configured){
      const dynamicImport=async(specifier:string)=>{
        if(typeof specifier!=="string")throw new Error("FIXTURE_IMPORT_PORT_REQUIRED dynamic specifier");
        const url=specifier.startsWith(".")?new URL(specifier,pathToFileURL(file)).href:isAbsolute(specifier)?pathToFileURL(specifier).href:specifier;
        if(IMPORT_PORTS.has(specifier)||url===new URL("../index.ts",import.meta.url).href)throw new Error("FIXTURE_IMPORT_PORT_REQUIRED index.ts");
        return guardedImport(url);
      };
      configured=new Function("__fixtureDynamicImport",`${prepared.code}\nreturn configured;`)(dynamicImport);
      prepared.plan.configured=configured;
    }
    // Only immutable executable code is cached. Each call enters a fresh
    // configured(scope) invocation and creates its own declarations/state.
    return configured!(prepared.bound);
  }
  function publicBinding(value: any, prepared: ReturnType<typeof prepare>) {
    const portScope=currentPortScope();
    const bound:Record<string,unknown>=Object.create(null);
    // Do not read private getters merely to remove them from the public view.
    for(const name of Object.keys(prepared.bound))if(!prepared.ports.has(name))Object.defineProperty(bound,name,Object.getOwnPropertyDescriptor(prepared.bound,name)!);
    for(const [name,resolution]of free)if(resolution.step==="import"&&prepared.bound[name]&&typeof prepared.bound[name]==="object")delete bound[name];
    const guard = (fn: (...args:any[])=>any) => function(this:unknown,...args:unknown[]) {
      return withinPortScope(()=>{
        assertPortsPristine();
        const result = Reflect.apply(fn,this,args);
        if(result && typeof result.then === "function")return result.finally(()=>assertPortsPristine());
        assertPortsPristine();return result;
      },portScope);
    };
    const checked=typeof value==="function"?guard(value):value;
    if(typeof checked==="function"&&originId)extractedOrigins.set(checked,{declaration:originId,owner:prepared.owner});
    if(checked && typeof checked==="object" && Object.getPrototypeOf(checked)===Object.prototype) {
      const references=productionSource?canonicalReturnedReferences(expression):new Map<string,string>();
      for(const key of Object.keys(checked))if(typeof checked[key]==="function") {
        checked[key]=guard(checked[key]);
        const name=references.get(key),node=name&&declarations.get(name);
        if(name&&node&&free.get(name)?.step==="declaration"&&(ts.isFunctionDeclaration(node)||ts.isVariableDeclaration(node)&&node.initializer&&(ts.isArrowFunction(node.initializer)||ts.isFunctionExpression(node.initializer)))) {
          const origin=resolveCaseDeclaration(source,name);if(origin)extractedOrigins.set(checked[key],{declaration:origin,owner:prepared.owner});
        }
      }
    }
    return {value:checked,bound:bound as Record<string,unknown>};
  }
  async function preflight(scope: Record<string, unknown> = {}, bindOptions: BindOptions = {}) {
    return withinPortScope(async()=>{
    if (productionSource && bindOptions.ports?.length) await preloadStatePortAdmission();
    const prepared = prepare(scope, bindOptions);
    for (const name of prepared.external) {
      const binding = imports.get(name);
      if (!binding) continue;
      if (IMPORT_PORTS.has(binding.specifier)) throw new Error(`FIXTURE_IMPORT_PORT_REQUIRED ${name}:${line(name)}`);
      const url = binding.specifier.startsWith(".") ? new URL(binding.specifier, pathToFileURL(file)).href : isAbsolute(binding.specifier) ? pathToFileURL(binding.specifier).href : binding.specifier;
      const module = await guardedImport(url);
      const value = binding.exported === "*" ? module : (module as Record<string, unknown>)[binding.exported];
      if (value === undefined) throw new Error(`FIXTURE_IMPORT_EXPORT_MISSING ${name}:${line(name)}`);
      if (Object.hasOwn(scope, name)) {
        const port=admitCaseOverride(source,name);
        checkCasePort(port,scope[name],value,()=>overrideRefused(name,resolveCaseDeclaration(source,name),source));
        if(port.category==="OBSERVER")prepared.bound[name]=observePort(name,scope[name],value);
      } else {trackPort(name,value,productionSource);prepared.bound[name]=protectPort(value);}

      free.set(name, { step: Object.hasOwn(scope,name) ? "case" : "import", line: line(name) });
    }
    const value = finish(prepared);
    for (const [name, result] of free) if (result.step !== "state" && Object.hasOwn(prepared.bound,name) && (typeof prepared.bound[name]!=="object" || prepared.bound[name]===null)) result.value = prepared.bound[name];
    return publicBinding(value,prepared);
    });
  }
  /** Resolve the actual import closure once for fixtures with synchronous APIs.
   * No caller-supplied implementation is accepted into this cache. */
  async function preload() {
    const prepared=prepare({},{});
    for(const name of prepared.external) {
      const binding=imports.get(name);if(!binding)continue;
      if(IMPORT_PORTS.has(binding.specifier))throw new Error(`FIXTURE_IMPORT_PORT_REQUIRED ${name}:${line(name)}`);
      const url=binding.specifier.startsWith(".")?new URL(binding.specifier,pathToFileURL(file)).href:isAbsolute(binding.specifier)?pathToFileURL(binding.specifier).href:binding.specifier;
      await guardedImport(url);
    }
  }
  /** Sync callers must preload real imports explicitly; missing exports fail construction. */
  function preflightSync(scope: Record<string, unknown> = {}, bindOptions: BindOptions = {}) {
    return withinPortScope(()=>{
    const prepared = prepare(scope, bindOptions);
    for (const name of prepared.external) {
      const binding = imports.get(name);
      if (!binding) continue;
      const url = binding.specifier.startsWith(".") ? new URL(binding.specifier, pathToFileURL(file)).href : isAbsolute(binding.specifier) ? pathToFileURL(binding.specifier).href : binding.specifier;
      const module = realImports.get(url);
      if(module===undefined&&Object.hasOwn(scope,name)) {
        const port=admitCaseOverride(source,name);
        if(port.category!=="IO")throw new Error(`FIXTURE_IMPORT_PORT_REQUIRED ${name}:${line(name)}`);
      }
      if (module === undefined && !Object.hasOwn(scope,name)) continue;
      const value = module === undefined ? scope[name] : binding.exported === "*" ? module : (module as Record<string,unknown>)[binding.exported];
      if (Object.hasOwn(scope,name)) {
        const port=admitCaseOverride(source,name);
        checkCasePort(port,scope[name],value,()=>overrideRefused(name,resolveCaseDeclaration(source,name),source));
        if(port.category==="OBSERVER")prepared.bound[name]=observePort(name,scope[name],value);
      } else {trackPort(name,value,productionSource);prepared.bound[name] = protectPort(value);}

    }
    return publicBinding(finish(prepared),prepared);
    });
  }
  return { code: expression, free, preflight, preflightSync, preload, source };
}
