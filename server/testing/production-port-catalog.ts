// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: sc-safety. Production module owners retain their implementations.
// Capture public class/singleton prototypes before case hooks. Reading the import
// declarations never imports index.ts or executes its server bootstrap.
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { containImport } from "./import-containment.ts";
import { registerPortConstructor, registerPortSingleton } from "./port-integrity.ts";
const indexFile=new URL("../index.ts",import.meta.url);
const index=ts.createSourceFile(fileURLToPath(indexFile),readFileSync(indexFile,"utf8"),ts.ScriptTarget.Latest,true);
const root=fileURLToPath(new URL("../../",import.meta.url));
for(const statement of index.statements) {
  if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier)
    ||!statement.moduleSpecifier.text.startsWith(".")||statement.importClause?.isTypeOnly)continue;
  const bindings=statement.importClause?.namedBindings;
  if(!bindings||!ts.isNamedImports(bindings))continue;
  const url=new URL(statement.moduleSpecifier.text,indexFile);
  if(!/\.[cm]?ts$/.test(url.pathname)||!existsSync(url))continue;
  const source=ts.createSourceFile(fileURLToPath(url),readFileSync(url,"utf8"),ts.ScriptTarget.Latest,true);
  const classes=new Set<string>(),singletons=new Set<string>();
  for(const declaration of source.statements) {
    if(ts.isClassDeclaration(declaration)&&declaration.name)classes.add(declaration.name.text);
    if(ts.isVariableStatement(declaration))for(const value of declaration.declarationList.declarations)
      if(ts.isIdentifier(value.name)&&value.initializer&&ts.isNewExpression(value.initializer))singletons.add(value.name.text);
  }
  // Uppercase value exports include constructors re-exported by a barrel or
  // native wrapper. Their public runtime export, rather than the local import
  // binding, supplies the prototype baseline.
  const selected=bindings.elements.filter(binding=>!binding.isTypeOnly&&(/^[A-Z]/.test((binding.propertyName??binding.name).text)||classes.has((binding.propertyName??binding.name).text)||singletons.has((binding.propertyName??binding.name).text)));
  if(!selected.length)continue;
  const module=await containImport(root,()=>import(url.href)) as Record<string,unknown>;
  for(const binding of selected) {
    const name=(binding.propertyName??binding.name).text,value=module[name];
    if(typeof value==="function"&&(/^[A-Z]/.test(name)||classes.has(name)))registerPortConstructor(value);
    else if(singletons.has(name)&&value&&typeof value==="object")registerPortSingleton(name,value);
  }
}
