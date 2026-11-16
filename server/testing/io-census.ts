// SPDX-License-Identifier: AGPL-3.0-or-later
import ts from "typescript";
/** Imported APIs, including aliases and namespace calls; unrelated object.spawn
 * methods and SQL exec calls are deliberately not subprocess sites. */
export function launchCalls(file:string,source:string):string[]{
 const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),names=new Map<string,string>(),namespaces=new Set<string>();
 const apis=new Set(["spawn","spawnSync","fork","exec","execSync","execFile","execFileSync"]);
 for(const node of tree.statements){
  if(!ts.isImportDeclaration(node)||!ts.isStringLiteral(node.moduleSpecifier)||! /^(node:)?child_process$/.test(node.moduleSpecifier.text))continue;
  const clause=node.importClause;if(!clause||clause.isTypeOnly)continue;
  if(clause.name)namespaces.add(clause.name.text);
  const bindings=clause.namedBindings;
  if(bindings&&ts.isNamespaceImport(bindings))namespaces.add(bindings.name.text);
  if(bindings&&ts.isNamedImports(bindings))for(const spec of bindings.elements){
   const api=spec.propertyName?.text??spec.name.text;if(apis.has(api)&&!spec.isTypeOnly)names.set(spec.name.text,api);
  }
 }
 function requireBinding(node:ts.Node){
  if(ts.isVariableDeclaration(node)&&node.initializer&&ts.isCallExpression(node.initializer)){
   const call=node.initializer;
   if(ts.isIdentifier(call.expression)&&call.expression.text==="require"&&call.arguments.length===1&&ts.isStringLiteral(call.arguments[0])&&/^(node:)?child_process$/.test(call.arguments[0].text)){
    if(ts.isIdentifier(node.name))namespaces.add(node.name.text);
    if(ts.isObjectBindingPattern(node.name))for(const spec of node.name.elements){
     if(!ts.isIdentifier(spec.name))continue;
     const api=spec.propertyName&&ts.isIdentifier(spec.propertyName)?spec.propertyName.text:spec.name.text;
     if(apis.has(api))names.set(spec.name.text,api);
    }
   }
  }
  ts.forEachChild(node,requireBinding);
 }
 requireBinding(tree);
 const calls:string[]=[],counts=new Map<string,number>();
 function visit(node:ts.Node){
  if(ts.isCallExpression(node)){
   const expr=node.expression;let api:string|undefined;
   if(ts.isIdentifier(expr))api=names.get(expr.text);
   if(ts.isPropertyAccessExpression(expr)&&ts.isIdentifier(expr.expression)&&namespaces.has(expr.expression.text)&&apis.has(expr.name.text))api=expr.name.text;
   if(api){const ordinal=(counts.get(api)??0)+1;counts.set(api,ordinal);calls.push(`${file}#${api}:${ordinal}`);}
  }
  ts.forEachChild(node,visit);
 }
 visit(tree);return calls;
}
