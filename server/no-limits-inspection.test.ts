// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {inspectOwnerOperation} from './no-limits-inspection.ts';
it('code bodies share taint without parsing raw Python as shell',()=>{
 const result=inspectOwnerOperation({kind:'code',lang:'py',cwd:'/tmp',cwdInvalid:false,text:"import os; os.system('ln -s /etc/hosts ./new'); os.system('tee ./new')"});
 expect(result.decisions).toContainEqual(expect.objectContaining({reason:'alias-taint',op:'write',lexical:'/tmp/new',taintTriggers:expect.any(Array)}));
 expect(inspectOwnerOperation({kind:'code',lang:'py',cwd:'/tmp',cwdInvalid:false,text:"import os; os.system('ln -s ./plain ./new'); os.system('tee ./new')"}).decisions).toEqual([]);
});
it('read-only code with protected strings invents no write effect',()=>{
 expect(inspectOwnerOperation({kind:'code',lang:'py',cwd:'/tmp',cwdInvalid:false,text:"print('/etc/hosts')"}).decisions).toEqual([]);
 expect(inspectOwnerOperation({kind:'code',lang:'js',cwd:'/tmp',cwdInvalid:false,text:"console.log('/etc/hosts')"}).decisions).toEqual([]);
});
it('code cuts remain incomplete rather than a successful empty inspection',()=>{
 expect(()=>inspectOwnerOperation({kind:'code',lang:'py',cwd:'/tmp',cwdInvalid:false,text:'('.repeat(201)+'0'+')'.repeat(201)})).toThrow();
});
