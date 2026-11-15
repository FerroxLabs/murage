import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {runNodeFixture} from './native-launcher.mjs';
const path=new URL('scan-native.mjs',import.meta.url),original=readFileSync(path,'utf8');
const before="['eval','Function','vm','require','constructor']";
assert.equal(original.split(before).length,2,'constructor ban must have exactly one mutation site');
const mutant=original.replace(before,"['eval','Function','vm','require']");
assert.notEqual(mutant,original);
try {
 writeFileSync(path,mutant);
 const result=runNodeFixture(['--test','--test-name-pattern=crev6 exact','scripts/windows/p11f.node-test.mjs'],{encoding:'utf8',timeout:60000});
 writeFileSync(new URL('evidence/cfix7-mutant-constructor.log',import.meta.url),result.stdout+result.stderr);
 assert.equal(result.signal,null);
 assert.equal(result.status,1,'SURVIVED dropped constructor ban');
 assert.match(result.stdout+result.stderr,/AssertionError|ERR_ASSERTION/);
 assert.match(result.stdout+result.stderr,/crev6 exact input escaped scanner/);
 console.log(`RED dropped constructor ban: exact crev6 assertion failed (exit ${result.status})`);
}finally{writeFileSync(path,original);}
