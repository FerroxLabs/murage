// SPDX-License-Identifier: AGPL-3.0-or-later
import {writeFileSync} from 'node:fs';
const identity=test=>{
 const names=[test.name];
 for(let parent=test.parent;parent&&parent.type!=='module';parent=parent.parent)names.unshift(parent.name);
 return {file:test.module.moduleId,id:names.join(' ')};
};
export default class MutantReporter {
 tests=[];
 onTestCaseResult(test){
  const result=test.result();
  this.tests.push({...identity(test),state:result.state,hooks:Object.values(test.task.result?.hooks??{}),errors:(result.errors??[]).map(({name,code,message,stack})=>({name,code,message,stack}))});
 }
 onTestRunEnd(modules,errors,reason){
  writeFileSync(process.env.TEST_TRUTH_MUTANT_REPORT,JSON.stringify({tests:this.tests,reason,errors:[...errors,...modules.flatMap(module=>[module,...module.children.allSuites()].flatMap(suite=>suite.errors()))].map(({name,message,stack})=>({name,message,stack}))})+'\n');
 }
}
