// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const files=['server/auto-approve.ts','server/decision/producer-contract.test.ts',
 'evidence/nlsym-build-C2/C6-GREEN.log','evidence/nlsym-build-C2/C6-first.log','evidence/nlsym-build-C2/C6-typecheck.log',
 'evidence/nlsym-build-C2/C7a-GREEN.log','evidence/nlsym-build-C2/C7a-first.log','evidence/nlsym-build-C2/C7a-second.log','evidence/nlsym-build-C2/pre-C6-RED.log'];
it.each(files)('A2 reviewed whitespace %s has one final newline',file=>{
 const text=readFileSync(file,'utf8');expect(text).toBe(text.trimEnd()+'\n');
});

it('A2 patch evidence keeps its exact original bytes in gzip',()=>{
 const path='evidence/afix-nlsym-build-B3/implementation.patch';
 expect(existsSync(path)).toBe(false);
 expect(createHash('sha256').update(gunzipSync(readFileSync(path+'.gz'))).digest('hex')).toBe('aee717d37773204a82e0cb1c7005d050ce696aef9cd8361159fabd8dff7061ac');
});
