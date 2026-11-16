// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: nl-backup owns this integration regression; tri3-g7-d owns accepted-write correlation.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
it('an exact correlated direct write confirms the native replay session, while duplicate write evidence does not', () => {
  const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
  const start=source.indexOf('const validateDirectSubmission ='),end=source.indexOf('onEngineWrite:',start);
  let callback:ts.ArrowFunction|undefined;
  const visit=(node:ts.Node)=>{if(ts.isPropertyAssignment(node)&&node.name.getText(ast)==='attemptWritten'&&node.pos>start&&node.pos<end&&ts.isArrowFunction(node.initializer))callback=node.initializer;ts.forEachChild(node,visit);};visit(ast);
  expect(callback).toBeDefined();
  let first=true;
  const written=vi.fn(),replay=vi.fn(),receipt=vi.fn();
  const context=vm.createContext({submissionBoundary:{attemptWritten:()=>{const result=first;first=false;return result;},noteEngineWrite:written},directAttemptWrite:receipt,dispatchClaimId:'generation',replayConfirmation:{engineWritten:replay}});
  vm.runInContext(ts.transpileModule(`globalThis.write=${callback!.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,context);
  context.write('write');context.write('write');
  expect(written).toHaveBeenCalledOnce();expect(receipt).toHaveBeenCalledOnce();expect(replay).toHaveBeenCalledOnce();
});
