// SPDX-License-Identifier: AGPL-3.0-or-later
// All commands are classifier inputs. The fixture never executes them.
import {expect,it} from 'vitest';
import {rawDynamicExecution} from '../shared/no-limits-raw-wipe.ts';
import {visibleWipe} from '../shared/no-limits-visible-wipe.ts';
import {noLimitsWipe} from './no-limits-wipe.ts';
import {recoveryExecutesScript,registerRecoveryScriptRequest} from './no-limits-wipe-scripts.ts';
import {d,fixture,baseRun} from './decision/fixture.ts';

const encoded=[
 `printf '\n\\x72\\x6d\\x20\\x2d\\x72\\x66\\x20\\x7e' | bash`,
 `printf "\n\\162\\155\\040\\055\\162\\146\\040\\176" | sh`,
 `printf '%s' 'echo ok' | bash`,
 `printf '%s' 'print(1)' | python3`,
 `bash -c "$(printf '%s' harmless)"`,
];
it.each(encoded)('R3 raw, server and Pi all hold printf execution: %s',command=>{
 expect(rawDynamicExecution(command)).toBe(true);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd:'/w'})).toBeNull();
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
 expect(visibleWipe(command,'/home/fixture',0,'posix','/w')).toBeNull();
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 const f=fixture();try{expect(d.decide(f.open('printf',{command}),baseRun).kind).toBe('run');}finally{f.dispose();}
});
const recoveryBodies=[
 `python3 -c 'import os; os.system("./cleanup.sh")'`,
 `python3 -c 'import subprocess; subprocess.run(["ls"])'`,
 `python3 -c 'exec("print(1)")'`,
 `python3 -c 'popen("ls")'`,
 `node -e 'require("child_process").spawn("ls")'`,
 `node -e 'process.spawn("ls")'`,
 `ruby -e 'system("ls")'`,
 'ruby -e \'`ls`\'',
 `python3 -c 'print("./cleanup.sh")'`,
 `node -e 'console.log("cleanup.mjs")'`,
 `bash -c 'echo cleanup.py'`,
 `python3 -c '# rm -rf ~\nprint("ok")'`,
 `node -e '/* DROP TABLE t */ console.log(1)'`,
 `python3 -c 'print("printf \\x72")'`,
];
it.each(recoveryBodies)('R6 literal inline recovery bodies reach a card: %s',command=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(recoveryExecutesScript(command)).toBe(false);
 const f=fixture();const release=registerRecoveryScriptRequest({threadId:'t',providerInstanceId:'p',turnId:'turn',requestId:'r3-inline'});
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 try{expect(d.decide(f.open('r3-inline',{command}),baseRun).kind).toBe('run');}finally{release();f.dispose();}
});
it.each([`python3 -c 'print("ok")'`,`node -e 'console.log("platform")'`,`bash -c 'echo ok'`])('R6 harmless literal inline recovery still runs: %s',command=>{
 expect(recoveryExecutesScript(command)).toBe(false);
});
