// SPDX-License-Identifier: AGPL-3.0-or-later
const key=test=>JSON.stringify([test.file,test.id]);
const clean=run=>run.code===0&&run.passed>0&&run.details?.reason==='passed'&&run.details.errors.length===0;
export function mutantKilled(green,red,restored){
 if(!clean(green)||!clean(restored)||red.code!==1||red.details?.reason!=='failed'||red.details.errors.length)return false;
 const intended=new Set(green.details.tests.filter(test=>test.state==='passed').map(key));
 const restoredIds=new Set(restored.details.tests.filter(test=>test.state==='passed').map(key));
 const failures=red.details.tests.filter(test=>test.state==='failed');
 return failures.length>0&&failures.every(test=>intended.has(key(test))&&restoredIds.has(key(test))&&(test.hooks??[]).every(state=>state==='pass')&&test.errors.length>0&&test.errors.every(error=>
  error.name==='AssertionError'&&!/timed?\s*out|timeout|hook|fixture/i.test(error.code??'')
  &&!/^(?:Test|Hook) timed out|^TimeoutError:/i.test(error.message??'')));
}
