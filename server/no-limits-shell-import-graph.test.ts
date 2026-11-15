// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { expect, it } from 'vitest';
import ts from 'typescript';
const root = new URL('../', import.meta.url).pathname;
const source = (file: string) => readFileSync(join(root, file), 'utf8');
const imports = (text: string): string[] => {
  const tree = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const paths: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) paths.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) paths.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) paths.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return paths;
};
function files(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
it('FA-IMPORT: Full access shell readers cannot reach No limits role modules', () => {
  const seen = new Set<string>();
  const queue = ['server/always-ask.ts', 'server/shell/walk.ts'];
  for (const file of queue) {
    if (seen.has(file)) continue;
    seen.add(file);
    expect(file).not.toMatch(/server\/shell\/(?:segments|roles|archive-roles)\.ts$/);
    for (const dependency of imports(source(file))) {
      if (dependency.startsWith('.') && dependency.endsWith('.ts')) queue.push(normalize(join(dirname(file), dependency)));
    }
  }
});
it('M-ONE: legacy call graph cannot reach owner readers or role modules',()=>{
 const modules=new Map<string,{nodes:Map<string,ts.Node>;bindings:Map<string,{file:string;name:string}>}>();
 function module(file:string){
  if(modules.has(file))return modules.get(file)!;
  const nodes=new Map<string,ts.Node>(),bindings=new Map<string,{file:string;name:string}>();
  const tree=ts.createSourceFile(file,source(file),ts.ScriptTarget.Latest,true);
  for(const node of tree.statements){
   if((ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node))&&node.name)nodes.set(node.name.text,node);
   if(ts.isVariableStatement(node))for(const d of node.declarationList.declarations)if(ts.isIdentifier(d.name))nodes.set(d.name.text,d);
   if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text.startsWith('.')&&!node.importClause?.isTypeOnly){
    const named=node.importClause?.namedBindings;
    if(named&&ts.isNamedImports(named))for(const b of named.elements)if(!b.isTypeOnly)bindings.set(b.name.text,{file:normalize(join(dirname(file),node.moduleSpecifier.text)),name:(b.propertyName??b.name).text});
   }
  }
  const entry={nodes,bindings};modules.set(file,entry);return entry;
 }
 const queue=[{file:'server/decision/implementation.ts',name:'describeAction'}],seen=new Set<string>();
 for(const item of queue){
  const key=item.file+':'+item.name;if(seen.has(key))continue;seen.add(key);
  expect(item.file).not.toMatch(/server\/shell\/(?:segments|roles|archive-roles)\.ts$/);
  expect(item.name).not.toMatch(/OwnerNl$/);
  const m=module(item.file),imported=m.bindings.get(item.name);
  if(imported){queue.push(imported);continue;}
  const node=m.nodes.get(item.name);if(!node)continue;
  const visit=(child:ts.Node)=>{
   if(ts.isIdentifier(child)&&child!==('name' in node?(node as any).name:undefined)){
    if(m.bindings.has(child.text)||m.nodes.has(child.text))queue.push({file:item.file,name:child.text});
   }
   ts.forEachChild(child,visit);
  };ts.forEachChild(node,visit);
 }
 // MAIN r2.1 int-A keeps 3b6e50f868: its legacy reader had no archive projection.
 expect(seen.has('server/no-limits-archives.ts:legacyArchiveWrites')).toBe(false);
 expect(seen.has('server/no-limits-shell.ts:simpleCommands')).toBe(true);
});
it('M-ONE: no private operator scanner is added outside the frozen legacy readers',()=>{

 for(const file of files('server').filter(file=>/^server\/no-limits-[^/]+\.ts$/.test(file)&&!file.endsWith('.test.ts')&&!/no-limits-(?:python|javascript)\.ts$/.test(file))){
  const tree=ts.createSourceFile(file,source(file),ts.ScriptTarget.Latest,true);
  const visit=(node:ts.Node,owner='')=>{
   const name=ts.isFunctionDeclaration(node)&&node.name?node.name.text:owner;
   if(ts.isForStatement(node)||ts.isWhileStatement(node)){
    let operators=false,indexing=false;
    const inspect=(part:ts.Node)=>{
     if(ts.isStringLiteral(part)&&/[;|&]/.test(part.text))operators=true;
     if(ts.isElementAccessExpression(part))indexing=true;
     ts.forEachChild(part,inspect);
    };inspect(node);
    if(operators&&indexing){
     const frozen=file==='server/no-limits-shell.ts'&&node.end<source(file).indexOf('/** Quote-aware executable segments.');
     expect(frozen,file+':'+name).toBe(true);
    }
   }
   ts.forEachChild(node,child=>visit(child,name));
  };visit(tree);
 }
});
