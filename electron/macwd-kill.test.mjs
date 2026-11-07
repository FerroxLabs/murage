import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
it('Mac kill driver portable regressions',()=>{
 const output=execFileSync(process.execPath,['--test','electron/macwd-kill.node-test.mjs'],{encoding:'utf8',timeout:30000});
 expect(output).toMatch(/(?:fail 0|# fail 0)/);
});
