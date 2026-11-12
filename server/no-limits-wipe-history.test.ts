// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it,vi} from 'vitest';
import {useOutsideStoreFixture} from './testing/outside-store-fixture.ts';
import {beginOutsideTurn,noteSessionEdits} from './email/external-marks.ts';
import {turnWrittenScripts} from './no-limits-wipe-scripts.ts';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeTempDirSync} from './testing/cleanup.ts';
vi.mock('node:fs',async original=>{const real=await original<typeof fs>();return {...real,statSync:vi.fn(real.statSync)};});
useOutsideStoreFixture();
it('R4 current-turn inspection never stats historical session edits; a repeated path is tracked again',async()=>{
 const real=await vi.importActual<typeof fs>('node:fs');const stat=vi.mocked(fs.statSync);stat.mockImplementation(real.statSync);
 const root=fs.mkdtempSync(join(tmpdir(),'wipe-history-'));
 try{
  const file=join(root,'current.sh');fs.writeFileSync(file,'rm -rf ~');
  beginOutsideTurn('history','engine','old',false,Date.now()-100);
  const old=Array.from({length:2000},(_,i)=>join(root,'old-'+i));noteSessionEdits('history','engine',[...old,file]);
  beginOutsideTurn('history','engine','current',true,Date.now()-50);
  stat.mockClear();expect([...turnWrittenScripts('history','engine','current')]).toEqual([]);expect(stat).not.toHaveBeenCalled();
  noteSessionEdits('history','engine',[file]);stat.mockClear();
  expect([...turnWrittenScripts('history','engine','current')]).toEqual([file]);
  expect(stat.mock.calls.every(call=>call[0]===file)).toBe(true);
  expect(stat.mock.calls.length).toBeLessThanOrEqual(1);
  expect([...turnWrittenScripts('history','wrong-engine','current')]).toEqual([]);
  expect([...turnWrittenScripts('history','engine','old')]).toEqual([]);
 }finally{removeTempDirSync(root);stat.mockRestore();}
});
