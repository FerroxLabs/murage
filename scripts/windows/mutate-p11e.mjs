import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {runNodeFixture} from './native-launcher.mjs';
const path=new URL('scan-native.mjs',import.meta.url),original=readFileSync(path,'utf8');
const mutant=readFileSync(new URL('evidence/cfix6-denylist-scanner.txt',import.meta.url),'utf8');
assert.notEqual(mutant,original);
try {
 writeFileSync(path,mutant);
 const result=runNodeFixture(['--test','--test-name-pattern=crev5 exact','scripts/windows/p11e.node-test.mjs'],{encoding:'utf8',timeout:60000});
 assert.equal(result.signal,null);
 assert.notEqual(result.status,0,'SURVIVED denylist-only JavaScript scanner');
 assert.match(result.stdout+result.stderr,/AssertionError|ERR_ASSERTION/);
 assert.match(result.stdout+result.stderr,/crev5 exact input escaped scanner/);
 writeFileSync(new URL('evidence/cfix6-mutant-denylist-only.log',import.meta.url),result.stdout+result.stderr);
 console.log(`RED denylist-only JavaScript scanner: exact crev5 assertion failed (exit ${result.status})`);
}finally{writeFileSync(path,original);}
