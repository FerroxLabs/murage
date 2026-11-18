// Owner: sc-safety mutant evidence. Runner owns the external report destination.
// Vitest's poll matcher keeps its AssertionError name but replaces the printed
// stack's first line with Error. Record the actual serialized error identity;
// message text alone can never turn an infrastructure error into a kill.
import {writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
export default class AssertionIdentityReporter {
  rows=[];
  onTestCaseResult(testCase){
    const result=testCase.result();
    if(result.state!=='failed')return;
    const identity=(error,depth=0)=>({name:error.name,constructor:error.constructorName??error.constructor?.name,message:error.message,
      ...(depth<4&&error.cause?{cause:identity(error.cause,depth+1)}:{})});
    const row={id:testCase.fullName,name:testCase.name,errors:result.errors.map(identity)};
    this.rows.push(row);
    const path=process.env.SC_ASSERTION_IDENTITY_REPORT;
    if(path){
      const target=resolve(path);if(!relative(process.cwd(),target).startsWith('..')||target==='/dev'||target.startsWith('/dev/'))throw Error('External assertion identity report required');
      writeFileSync(target,JSON.stringify(this.rows,null,2));
    }
  }
}
