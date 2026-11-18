// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {judge} from './no-limits-code.ts';
it('retains a resolved system target before the shared work cut', () => {
 const code="import shutil\nfrom pathlib import Path\nshutil.rmtree(Path('/') / 'etc')\n"+'x=0\n'.repeat(140000);
 expect(judge('execute_code',code)).toMatchObject({verdict:'card',cls:'system'});
});

it.each(['before','after'])('retains an effect %s a large parameter list', position => {
 const effect="import shutil\nfrom pathlib import Path\nshutil.rmtree(Path('/') / 'etc')\n";
 const parameters='def f('+'a,'.repeat(400000)+'): pass\n';
 expect(judge('execute_code',position==='before'?effect+parameters:parameters+effect)).toMatchObject({verdict:'card',cls:'system'});
});

it('retains a nested effect before keyword/context leaves exhaust the shared budget', () => {
 const code="match x:\n  case 1: import shutil; shutil.rmtree('/')\n"+'f(a=0)\n'.repeat(80000);
 expect(judge('execute_code',code)).toMatchObject({verdict:'card',cls:'root'});
});

it('retains an exec twin before outer keyword leaves exhaust the shared budget', () => {
 const code="exec(\"import shutil; shutil.rmtree('/')\")\n"+'f(a=0)\n'.repeat(80000);
 expect(judge('execute_code',code)).toMatchObject({verdict:'card',cls:'root'});
});

it.each(['1j', '.5', '1e2'])('keeps scanning after an unresolved numeric value %s', number => {
 expect(judge('python', `x = ${number} + 2`)).toMatchObject({verdict:'card',cls:'cut'});
 const code=`match x:\n  case 1: import shutil; shutil.rmtree('/')\nx = ${number} + 2`;
 expect(judge('execute_code',code)).toMatchObject({verdict:'card',cls:'root'});
});
