// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import ts from 'typescript';
import vm from 'node:vm';
import { source, wiring } from './fixture.ts';
import { wipeContextFor } from '../wipe/context.ts';
import { d, fixture, baseCard, card } from '../decision/fixture.ts';

it('H1 production boot captures before consumers and installs the builder after host reset before recovery', async () => {
  const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
  const names=['installRequestIngress','installDecisionHost','installEngineApprovalBuilder'];
  const calls=ast.statements.filter(node=>ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&names.includes(node.expression.expression.getText(ast)));
  expect(calls.map(node=>(node as ts.ExpressionStatement).expression.getText(ast).split('(')[0])).toEqual(names);
  const ingress = source.indexOf('installRequestIngress(bus)');
  const consumer = source.indexOf('bus.subscribeExecution(');
  expect(ingress).toBeGreaterThanOrEqual(0); // MAIN RULING 1115-R5RUL-20 (GrokBuild)
  expect(consumer).toBeGreaterThanOrEqual(0); // MAIN RULING 1115-R5RUL-20 (GrokBuild)
  expect(ingress).toBeLessThan(consumer); // MAIN RULING 1115-R5RUL-20 (GrokBuild)
  expect(source.indexOf('installEngineApprovalBuilder(decisionEngineApprovalAction)')).toBeLessThan(source.indexOf('await recover()'));
  for(const level of ['ask','full'] as const) {
    const f=fixture(level);
    try {
      const {decisionEngineApprovalAction}=wiring(['decisionEngineApprovalAction','approveAllTurnOrigin'],{
        approvalCardGrants:()=>({}), approvalIsCut:()=>false, isQuestionTool:()=>false,
        store:{botByThread:()=>undefined,groupByThread:()=>undefined}, groupSpeakers:new Map(),
        exactAllowKeyFor:()=>undefined, routineCardFields:()=>({}), actionGrantSet:()=>undefined,
        routines:undefined, isUnattended:()=>false, turnCwdByThread:new Map(),
        fullAccessTurnOrigin:()=> 'owner', internalTurnOwners:new Map([['t',{ownerTyped:true}]]), commandFromToolInput:()=>undefined,
        stopHitByRequest:new Map(), approvalHoldNote:()=>undefined, lowRiskStamp:()=>({}),
      });
      const code=calls.map(node=>node.getText(ast)).join('\n');
      vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None}}).outputText,{
        installDecisionHost:d.installDecisionHost,installEngineApprovalBuilder:d.installEngineApprovalBuilder,
        installRequestIngress:()=>{},wipeContextFor,store:f.store,decisionEngineView:()=>({title:'Approval',subtitle:''}),
        decisionEngineApprovalAction,bus:{},
      });
      const result=d.decide(f.open(),baseCard);
      expect(result.kind).toBe('card');
      await d.presentApproval(card(result),{title:'Approval',subtitle:''});
      expect(d.readApproval(card(result).approvalId)?.action.options).toEqual(['Allow','Deny']);
    } finally { f.dispose(); }
  }
});
