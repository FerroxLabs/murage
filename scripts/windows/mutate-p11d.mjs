import {runNodeFixture} from './native-launcher.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const path=new URL('scan-native.mjs',import.meta.url),original=readFileSync(path,'utf8');
const mutant=readFileSync(new URL('evidence/cfix5-regex-scanner.txt',import.meta.url),'utf8');
assert.notEqual(mutant,original);
try {
 writeFileSync(path,mutant);
 const result=runNodeFixture(['--test','--test-name-pattern=crev4 exact','scripts/windows/p11d.node-test.mjs'],{encoding:'utf8',timeout:60000});
 assert.equal(result.signal,null);
 assert.notEqual(result.status,0,'SURVIVED regex-only scanner');
 assert.match(result.stdout+result.stderr,/AssertionError|ERR_ASSERTION/);
 assert.match(result.stdout+result.stderr,/crev4 exact input escaped scanner/);
 writeFileSync(new URL('evidence/cfix5-mutant-regex-only.log',import.meta.url),result.stdout+result.stderr);
 console.log(`RED regex-only scanner: exact crev4 assertion failed (exit ${result.status})`);
}finally{writeFileSync(path,original);}
