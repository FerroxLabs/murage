import { it, expect } from 'vitest';
import { renameWithRetrySync } from './rename-retry.mjs';
for (const code of ['EPERM','EACCES','EBUSY']) {
  it(`retries transient Windows ${code} only within the bound`, () => {
    let calls=0; const pause=[];
    const rename=()=>{if(++calls<3)throw Object.assign(new Error(code),{code});};
    renameWithRetrySync('from','to',{platform:'win32',rename,pause:ms=>pause.push(ms),attempts:3});
    expect(calls).toBe(3);expect(pause).toEqual([10,10]);
    calls=0;const error=Object.assign(new Error(code),{code});
    expect(()=>renameWithRetrySync('from','to',{platform:'win32',rename:()=>{calls++;throw error;},pause:()=>{},attempts:3})).toThrow(error);
    expect(calls).toBe(3);
  });
}
it('never retries other errors or POSIX failures',()=>{
  for(const [platform,code] of [['linux','EBUSY'],['win32','ENOENT']]){
    let calls=0;const error=Object.assign(new Error(code),{code});
    expect(()=>renameWithRetrySync('from','to',{platform,rename:()=>{calls++;throw error;},pause:()=>{throw Error('unexpected pause');}})).toThrow(error);
    expect(calls).toBe(1);
  }
});
