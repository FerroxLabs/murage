// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: sc-safety (case admission). Production modules own resolved declarations.
import ts from "typescript";
import { isExtractedFunctionFor } from "./source-extract.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { Store } from "../store.ts";
import { registerPortConstructor, isPortObserver } from "./port-integrity.ts";
import { isExecutionStoreFixture } from "./execution-store-fixture.ts";

registerPortConstructor(Store);
export interface DeclarationId { file: string; start: number; exportName: string; line: number }
export interface CasePort { declaration: DeclarationId; category: "IO" | "OBSERVER" | "DATA"; reason: string; ownerBound?:boolean; accepts?: (value: unknown) => boolean }
const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const sources = new Map<string, ts.SourceFile>();
const checkers = new WeakMap<ts.SourceFile, ts.TypeChecker>();
function source(file: string): ts.SourceFile | undefined {
  if (!existsSync(file)) return;
  let sf = sources.get(file);
  if (!sf) { sf = ts.createSourceFile(file, readFileSync(file,"utf8"), ts.ScriptTarget.Latest, true); sources.set(file,sf); }
  return sf;
}
function checkerFor(sf: ts.SourceFile): ts.TypeChecker {
  let checker = checkers.get(sf);
  if (!checker) {
    const host = ts.createCompilerHost({ noLib:true, noResolve:true });
    host.getSourceFile = file => resolve(file) === resolve(sf.fileName) ? sf : undefined;
    checker = ts.createProgram([sf.fileName],{noLib:true,noResolve:true},host).getTypeChecker(); checkers.set(sf,checker);
  }
  return checker;
}
function imported(from:ts.SourceFile,specifier:string):ts.SourceFile|undefined {
  if (!specifier.startsWith(".")) return;
  const file=resolve(dirname(from.fileName),specifier);
  return source(file) ?? source(file+".ts") ?? source(resolve(file,"index.ts"));
}
function externalDeclaration(from: ts.SourceFile, specifier: string, name: string): DeclarationId | undefined {
  if (specifier.startsWith("node:")) {
    const moduleName=specifier.slice(5);
    const file=resolve(root,"node_modules/@types/node",`${moduleName}.d.ts`), owner=source(file);
    if(!owner)return;
    let declaration:ts.Declaration|undefined;
    const visit=(node:ts.Node):void=>{
      if(ts.isModuleDeclaration(node)&&ts.isStringLiteral(node.name)&&(node.name.text===moduleName||node.name.text===specifier)&&node.body&&ts.isModuleBlock(node.body)) {
        for(const statement of node.body.statements) {
          if((ts.isFunctionDeclaration(statement)||ts.isClassDeclaration(statement))&&statement.name?.text===name)declaration??=statement;
          if(ts.isVariableStatement(statement))for(const item of statement.declarationList.declarations)if(ts.isIdentifier(item.name)&&item.name.text===name)declaration??=item;
        }
      }
      ts.forEachChild(node,visit);
    };
    visit(owner);
    if(!declaration)return;
    const start=(declaration as ts.Declaration).getStart(owner);
    return {file:resolve(owner.fileName),start,exportName:name,line:owner.getLineAndCharacterOfPosition(start).line+1};
  }
  const resolution=ts.resolveModuleName(specifier,from.fileName,{module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext},ts.sys).resolvedModule;
  const owner=resolution&&source(resolution.resolvedFileName);
  return owner?resolveDeclaration(owner,name):undefined;
}
function unwrap(node:ts.Expression):ts.Expression {
  while(ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isParenthesizedExpression(node))node=node.expression;
  return node;
}
function localEdge(sf:ts.SourceFile,name:string):DeclarationId|undefined {
  const canonical=source(resolve(sf.fileName));
  let scope:ts.Node|undefined;
  const scopeName=resolve(sf.fileName)===resolve(root,"server/index.ts")?"handleRequest"
    :resolve(sf.fileName)===resolve(root,"server/drivers/claude.ts")?"sendTurnCaptured":undefined;
  if(scopeName&&canonical) {
    const find=(node:ts.Node):void=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text===scopeName)scope=node.initializer;else ts.forEachChild(node,find);};find(canonical);
    let declaration:ts.Node|undefined;
    const findBinding=(node:ts.Node):void=>{
      if(!declaration&&(ts.isParameter(node)||ts.isVariableDeclaration(node)||ts.isBindingElement(node))&&ts.isIdentifier(node.name)&&node.name.text===name)declaration=node;
      ts.forEachChild(node,findBinding);
    };
    if(scope)findBinding(scope);
    const bound=declaration as ts.Node|undefined;
    if(bound){const start=bound.getStart(canonical);return {file:resolve(canonical.fileName),start,exportName:name,line:canonical.getLineAndCharacterOfPosition(start).line+1};}
  }
  // Explicit runtime globals still have a real TypeScript declaration. They
  // never acquire the identity of an unresolved name in a synthetic fixture.
  if(["fetch","setTimeout","clearTimeout","console"].includes(name)) {
    const lib=source(resolve(dirname(ts.getDefaultLibFilePath({})),"lib.dom.d.ts"));
    if(lib){const symbol=checkerFor(lib).resolveName(name,lib,ts.SymbolFlags.Value,false),decl=symbol?.valueDeclaration??symbol?.declarations?.[0];
      if(decl){const start=decl.getStart(lib);return {file:resolve(lib.fileName),start,exportName:name,line:lib.getLineAndCharacterOfPosition(start).line+1};}}
  }
}
/** Resolve binder symbols first, then follow import/re-export and local value aliases.
 * A noResolve checker deliberately avoids executing or typechecking the server's
 * entire dependency graph. Unloaded alias edges are followed from their AST. */
function resolveDeclaration(sf:ts.SourceFile,name:string,seen=new Set<string>()):DeclarationId|undefined {
  const key=resolve(sf.fileName)+"\0"+name;
  if(seen.has(key))return;
  seen.add(key);
  if(name.includes(".")) {
    const [base,...members]=name.split(".");
    for(const statement of sf.statements) {
      if(ts.isClassDeclaration(statement)&&statement.name?.text===base&&members.length===1) {
        const member=statement.members.find(member=>member.name&&member.name.getText(sf)===members[0]&&(!ts.isMethodDeclaration(member)||!!member.body));
        if(member){const start=member.getStart(sf);return {file:resolve(sf.fileName),start,exportName:name,line:sf.getLineAndCharacterOfPosition(start).line+1};}
      }
      if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.importClause?.namedBindings
        &&ts.isNamespaceImport(statement.importClause.namedBindings)&&statement.importClause.namedBindings.name.text===base) {
        const target=imported(sf,statement.moduleSpecifier.text);return target?resolveDeclaration(target,members.join("."),seen):externalDeclaration(sf,statement.moduleSpecifier.text,members.join("."));
      }
      if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)
        if(ts.isIdentifier(declaration.name)&&declaration.name.text===base&&declaration.initializer&&ts.isIdentifier(unwrap(declaration.initializer)))
          return resolveDeclaration(sf,`${unwrap(declaration.initializer).getText(sf)}.${members.join(".")}`,seen);
    }
    return;
  }
  const checker=checkerFor(sf);
  let symbol=checker.resolveName(name,sf,ts.SymbolFlags.Value,false);
  if(symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) {
    const target=checker.getAliasedSymbol(symbol);
    if(target.valueDeclaration)symbol=target;
  }
  let declaration=symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  for(const statement of sf.statements) {
    if(ts.isImportDeclaration(statement)&&statement.importClause&&ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause=statement.importClause,bindings=clause.namedBindings;
      const item=bindings&&ts.isNamedImports(bindings)?bindings.elements.find(item=>item.name.text===name):undefined;
      const namespace=bindings&&ts.isNamespaceImport(bindings)&&bindings.name.text===name;
      if(item||namespace||clause.name?.text===name) {
        const target=imported(sf,statement.moduleSpecifier.text);
        if(target) {
          if(namespace) {
            const members=new Set<string>();
            const walk=(node:ts.Node):void=>{if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text===name)members.add(node.name.text);ts.forEachChild(node,walk);};
            walk(sf);
            if(members.size===1)return resolveDeclaration(target,[...members][0],seen);
            return {file:resolve(target.fileName),start:0,exportName:"*",line:1};
          }
          return resolveDeclaration(target,item?(item.propertyName??item.name).text:"default",seen);
        }
        if(!statement.moduleSpecifier.text.startsWith(".")) {
          if(namespace) {
            const members=new Set<string>();
            const walk=(node:ts.Node):void=>{if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text===name)members.add(node.name.text);ts.forEachChild(node,walk);};walk(sf);
            return members.size===1?externalDeclaration(sf,statement.moduleSpecifier.text,[...members][0]):undefined;
          }
          return externalDeclaration(sf,statement.moduleSpecifier.text,item?(item.propertyName??item.name).text:"default");
        }
        // A missing target is unresolved; an import binding is never the
        // production declaration and cannot acquire a CASE_PORTS identity.
        return undefined;
      }
    }
    if(ts.isExportDeclaration(statement)&&!statement.moduleSpecifier&&statement.exportClause&&ts.isNamedExports(statement.exportClause)) {
      const item=statement.exportClause.elements.find(item=>item.name.text===name);
      if(item?.propertyName)return resolveDeclaration(sf,item.propertyName.text,seen);
    }
    if(ts.isExportDeclaration(statement)&&statement.moduleSpecifier&&ts.isStringLiteral(statement.moduleSpecifier)) {
      const target=imported(sf,statement.moduleSpecifier.text);
      if(!target)continue;
      if(!statement.exportClause) {const found=resolveDeclaration(target,name,new Set(seen));if(found&&found.start>=0)return found;}
      if(statement.exportClause&&ts.isNamedExports(statement.exportClause)) {
        const item=statement.exportClause.elements.find(item=>item.name.text===name);
        if(item)return resolveDeclaration(target,(item.propertyName??item.name).text,seen);
      }
    }
  }
  if(declaration&&ts.isVariableDeclaration(declaration)&&declaration.initializer) {
    const value=unwrap(declaration.initializer);
    if(ts.isIdentifier(value))return resolveDeclaration(sf,value.text,seen);
    if(ts.isPropertyAccessExpression(value)&&ts.isIdentifier(value.expression)) {
      for(const statement of sf.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)
        &&statement.importClause?.namedBindings&&ts.isNamespaceImport(statement.importClause.namedBindings)
        &&statement.importClause.namedBindings.name.text===value.expression.text) {
        const target=imported(sf,statement.moduleSpecifier.text);if(target)return resolveDeclaration(target,value.name.text,seen);
      }
    }
  }
  if(!declaration){const edge=localEdge(sf,name);if(edge)return edge;}
  const owner=declaration?.getSourceFile()??sf,start=declaration?.getStart(owner)??-1;
  return {file:resolve(owner.fileName),start,exportName:name,line:declaration?owner.getLineAndCharacterOfPosition(start).line+1:1};
}
const resolutions=new WeakMap<ts.SourceFile,Map<string,DeclarationId|undefined>>();
export function resolveCaseDeclaration(sf:ts.SourceFile,name:string):DeclarationId|undefined {
  let names=resolutions.get(sf);if(!names){names=new Map();resolutions.set(sf,names);}
  if(!names.has(name))names.set(name,resolveDeclaration(sf,name));
  return names.get(name);
}
export const declarationKey = (id:DeclarationId):string => JSON.stringify([id.file,id.start,id.exportName]);
const index=source(resolve(root,"server/index.ts"))!;
function entry(name:string,category:CasePort["category"],reason:string,accepts?:CasePort["accepts"],owner=index):CasePort {
  const declaration=resolveDeclaration(owner,name);
  if(!declaration||declaration.start<0)throw new Error(`FIXTURE_CASE_DECLARATION_MISSING ${name}`);
  return Object.freeze({declaration:Object.freeze(declaration),category,reason,accepts});
}
/** No authority predicate, grant, refusal classifier or registry is replaceable.
 * Each entry identifies the declaration, including for renamed imports. */
export const CASE_PORTS:readonly CasePort[]=Object.freeze([
  ...["turn","threadId"].map(name=>entry(name,"IO","Explicit draft and thread input to the real mount configuration writer.",undefined,source(resolve(root,"server/drivers/claude.ts"))!)),
  ...["req","res","originalResponse","readBody","body","path","url","method"].map(name=>entry(name,"IO","Private request/response edge of the extracted HTTP callback.")),
  ...["database","transaction","fetch","broadcast","readFileSync","existsSync","setTimeout","clearTimeout","console"].map(name=>entry(name,"IO","Explicit isolated storage, transport or scheduling edge; policy stays in production code.")),
  ...["settledBrowserEngineStatus","verifyAgentBrowserBinary","agentBrowserIntegration"].map(name=>entry(name,"IO","Virtual browser executable discovery and version I/O; real lifecycle, capability and ownership gates remain in the extracted mount.")),
  ...["imageSettings", "imageConnection", "searchFreeWeb", "searchWeb", "FreeWebSearchError", "SearchError"].map(name=>entry(name,"IO","Explicit provider catalog/search data and error boundary; capability, audience, own-write and final response authorization remain production declarations.")),
  entry("cfg","DATA","JSON settings data for the isolated installation; executable values and accessors are refused.",value=>jsonSettings(value)),
  entry("store","DATA","Complete real Store over the per-worker temporary installation, or the branded execution store fixture.",value=>validStore(value)),
  ...["patchMessage","scanNewest"].map(name=>entry(`Store.${name}`,"IO","Fixture SQLite storage edge; all roster and authorization readers remain the real Store methods.",undefined,source(resolve(root,"server/store.ts"))!)),
  ...["createBot","appendMessage","rowsOfKind","markPhoneUsed"].map(name=>entry(`Store.${name}`,"OBSERVER","A locked fixture observer executes the identical real Store writer, with unchanged arguments and results.",undefined,source(resolve(root,"server/store.ts"))!)),
  entry("ASK_USER_REFUSED","DATA","Question refusal display copy only; real audience and service guards choose the refusal.",value=>typeof value==="string"&&value.length>0),
  entry("WIDGET_REFUSED","DATA","Refusal display copy only; the real widget service and authorization choose whether to refuse.",value=>typeof value==="string"&&value.length>0),
  ...["consumingHttpWriter", "registerArtifact", "chatAllowance", "createVoiceNote", "relayMcpCall", "credentialIsConfigured", "manageBot", "partitionRoster", "stageSkillWrite", "listSkills", "parseConnectorRequests", "threadRecallRoute", "memoryAccess", "requestBotAccess", "permissionStatus", "proposeOutcomeFromAgent", "fromAskUser", "updateWidget", "addBotMcpServer", "listPromptBlocksForBot", "getPromptBlock", "savePromptBlock", "listReferencePacksForBot", "saveReferencePack", "imageReferences", "askBotRoute", "delegateBotRoute", "checkDelegationRoute", "askOwnerToShare"].map(name=>entry(name,"OBSERVER","Observe the identical real production export; queued or replacement implementations are refused.")),
  ...["releaseBrowserCapabilityForThread", "notify", "venuePostStored", "roomAskDuplicate", "maybeResumeConnectors"].map(name=>({...entry(name,"OBSERVER","Observe the identical production declaration bound to this fixture’s private state."),ownerBound:true})),
  ...["agentRoutine", "agentWebhook", "routineTimestamp", "labelledImageConnections", "defaultImageConnection"].map(name=>entry(name,"OBSERVER","Observe the exact real source-extracted formatter; the extractor alone records its canonical declaration identity.")),
  entry("showWidget","OBSERVER","Observe the identical real widget writer without replacing its implementation."),
]);
function jsonSettings(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || ["undefined", "boolean", "number", "string"].includes(typeof value)) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  seen.add(value);
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => "value" in descriptor && jsonSettings(descriptor.value,seen));
}
function validStore(value:unknown):boolean {
  if(isExecutionStoreFixture(value))return Object.isFrozen(value);
  if(!(value instanceof Store)||Object.getPrototypeOf(value)!==Store.prototype)return false;
  const owner=source(resolve(root,"server/store.ts"))!;
  for(const key of Reflect.ownKeys(value)) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
    // A real Store's getters live on its registered prototype. Caller-owned
    // accessors, including roster/revision fields, are executable overrides.
    if(descriptor.get||descriptor.set)return false;
    if(typeof descriptor.value!=="function"||typeof key!=="string")continue;
    if(typeof Object.getOwnPropertyDescriptor(Store.prototype,key)?.value!=="function")continue;
    const declaration=resolveDeclaration(owner,`Store.${key}`);
    const port=declaration&&CASE_PORTS.find(port=>declarationKey(port.declaration)===declarationKey(declaration));
    if(!port||port.category!=="IO"&&!(port.category==="OBSERVER"&&isPortObserver(descriptor.value,Object.getOwnPropertyDescriptor(Store.prototype,key)?.value)))return false;
  }
  return true;
}
const casePortsByDeclaration=new Map<string,CasePort>();
for(const port of CASE_PORTS)if(!casePortsByDeclaration.has(declarationKey(port.declaration)))casePortsByDeclaration.set(declarationKey(port.declaration),port);
export function casePortFor(declaration:DeclarationId|undefined):CasePort|undefined {
  return declaration&&casePortsByDeclaration.get(declarationKey(declaration));
}
export function overrideRefused(name:string,declaration:DeclarationId|undefined,sf:ts.SourceFile):Error {
  return new Error(`FIXTURE_OVERRIDE_REFUSED ${name} ${declaration?.file??sf.fileName}:${declaration?.line??1} declaration=${declaration?.exportName??name}@${declaration?.start??-1}`);
}
export function checkCasePort(port:CasePort,value:unknown,real:unknown,refuse:()=>Error,owner?:object):void {
  if(port.category==="DATA"&&(!port.accepts||!port.accepts(value)))throw refuse();
  if(port.category==="OBSERVER"&&(!vi.isMockFunction(value)||(real!==undefined?value.getMockImplementation()!==real:!isExtractedFunctionFor(value.getMockImplementation(),port.declaration,owner,port.ownerBound))))throw refuse();
}
