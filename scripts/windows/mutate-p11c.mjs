import {runNodeFixture} from './native-launcher.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {runLinuxFixture} from './native-launcher.mjs';
const pwsh=process.env.WINSCEN_PWSH||'.test-tmp/cfix4-winscen/pwsh/pwsh';
const fixture=JSON.parse(readFileSync(new URL('native-scanner-fixtures.json',import.meta.url),'utf8'));
const cases=[
 {name:'enumeration-before-removal',file:'ownership.ps1',change:s=>s.replace('    Remove-WrapperTask -Item ([pscustomobject]@{id=$Task})',"    Get-TaskSnapshot\n    Remove-WrapperTask -Item ([pscustomobject]@{id=$Task})"),ps:true},
 {name:'cleanup-without-deadline',file:'ownership.ps1',change:s=>s.replace(' -Deadline ([DateTime]::UtcNow.AddSeconds(60))',''),ps:true},
 {name:'node-native-kill',file:'packaged-scenario.mjs',change:s=>s+'\n'+fixture.find(f=>f.code.startsWith('child.')).code},
 {name:'taskkill-in-test',file:'nested-lowercase-test.cmd',create:fixture.find(f=>f.ext==='.psm1').code},
];
for(const m of cases) {
 const file=new URL(m.file,import.meta.url),original=m.create?null:readFileSync(file,'utf8');
 const changed=m.create??m.change(original);assert.notEqual(changed,original);
 try {
  writeFileSync(file,changed);
  const r=m.ps?runLinuxFixture(pwsh,['-NoProfile','-File','scripts/windows/p11c-check.ps1'],{encoding:'utf8',timeout:60000}):runNodeFixture(['--test','scripts/windows/p11c.node-test.mjs'],{encoding:'utf8',timeout:60000});
  assert.equal(r.signal,null);assert.notEqual(r.status,0,`SURVIVED ${m.name}`);
  assert.match(r.stdout+r.stderr,/ASSERTION:|AssertionError|ERR_ASSERTION/,'assertion failure required');
  writeFileSync(new URL(`evidence/cfix4-mutant-${m.name}.log`,import.meta.url),r.stdout+r.stderr);
  console.log(`RED ${m.name} (assertion failure, exit ${r.status})`);
 }finally{if(original===null)unlinkSync(file);else writeFileSync(file,original);}
}
