import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const source = (path:string) => ts.createSourceFile(path,readFileSync(new URL(path,root),'utf8'),ts.ScriptTarget.Latest,true);
function calls(node:ts.Node):Set<string> {
  const names=new Set<string>();
  function visit(node:ts.Node):void {
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression))names.add(node.expression.text);
    ts.forEachChild(node,visit);
  }
  visit(node);return names;
}
function files(path:string):string[] {
  return readdirSync(new URL(path+'/',root),{withFileTypes:true}).flatMap(entry=>{
    const child=join(path,entry.name);
    return entry.isDirectory()?files(child):child.endsWith('.ts')&&!/\.(test|fixture)\.ts$/.test(child)?[child]:[];
  });
}
// These overrides have working production defaults. They are used solely to
// replace behavior in tests; none is a required boot capability.
const testOnly:Record<string,string>={
  installProducerQueueFactory:'Test override; producerQueue uses tracked production sources and its built-in source factory.',
  installB34ScriptedExtractor:'Fixture-only scripted extractor under memory/testing; production must never launch its fake HTTP service.',
  installB34EvaluatorRuntime:'Fixture-only evaluator under memory/testing; production must never launch its deterministic scoring service.',
};

it('every exported decision, HighLevel and memory installer has a production index.ts caller',()=>{
  const installers=new Set<string>();
  for(const file of ['decision','highlevel','memory'].flatMap(files)) {
    const syntax=source(file);
    for(const statement of syntax.statements) {
      const exported=ts.canHaveModifiers(statement)&&ts.getModifiers(statement)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword);
      if(!exported)continue;
      if(ts.isFunctionDeclaration(statement)&&statement.name?.text.startsWith('install'))installers.add(statement.name.text);
      if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)
        if(ts.isIdentifier(declaration.name)&&declaration.name.text.startsWith('install'))installers.add(declaration.name.text);
    }
  }
  const bootCalls=calls(source('index.ts'));
  // These internal capabilities are deliberately installed together by the
  // public host installer. Prove the actual host body calls each one, and that
  // index.ts calls that host; comments and re-exports cannot satisfy the guard.
  const implementation=source('decision/implementation.ts');
  const host=implementation.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='installDecisionHost');
  if(bootCalls.has('installDecisionHost')&&host)for(const name of ['installReleaseContextReader','installNativeReleaseReader'])
    if(calls(host).has(name))bootCalls.add(name);
  for(const [name,reason]of Object.entries(testOnly)){
    expect(installers.has(name),`stale test-only exception: ${name}`).toBe(true);
    expect(reason.length).toBeGreaterThan(30);
    expect(bootCalls.has(name),`production installer cannot be test-only: ${name}`).toBe(false);
  }
  const missing=[...installers].filter(name=>!bootCalls.has(name)&&!testOnly[name]).sort();
  expect(missing,'Missing production boot wiring (C2 is owned by ask-cards; merge its install rather than exempting it)').toEqual([]);
});
