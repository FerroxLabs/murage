import {runNodeFixture} from './native-launcher.mjs';
// Container only. Mutate the real boundary, run its tests, and restore in finally.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {runLinuxFixture} from './native-launcher.mjs';
const pwsh=process.env.WINSCEN_PWSH || '.test-tmp/cfix4-winscen/pwsh/pwsh';
const mutants=[
 {name:'skip-launcher-cleanup',file:'run-interactive.ps1',change:s=>s.replace('Invoke-LauncherCleanup -Task', '& { param($Task) } -Task'),tests:['safety.node-test.mjs']},
 {name:'accept-junction',file:'package-identity.mjs',change:s=>s.replace(' const full=resolve(file),base=resolve(root),rel=relative(base,full);',' return resolve(file);\n const full=resolve(file),base=resolve(root),rel=relative(base,full);'),tests:['safety.node-test.mjs']},
 {name:'compare-only-exe',file:'receipt-pair.mjs',change:s=>s.replace("'commit','packageSha256','sha256'","'commit','sha256'").replace("  assert.deepEqual(sorted[0].appManifest,sorted[1].appManifest,'same full staged app manifest required');",''),tests:['receipt-pair.node-test.mjs']},
];
for(const m of mutants){
 const file=new URL(m.file,import.meta.url),original=readFileSync(file,'utf8'),mutated=m.change(original);assert.notEqual(mutated,original);
 try{
  writeFileSync(file,mutated);
  const r=runNodeFixture(['--test',...m.tests.map(p=>'scripts/windows/'+p)],{encoding:'utf8',timeout:60000});
  assert.equal(r.signal,null);assert.notEqual(r.status,0,`SURVIVED: ${m.name}`);
  assert.match(r.stdout,/AssertionError|ERR_ASSERTION|Missing expected exception/,'must fail assertions, not import/setup');
  writeFileSync(new URL(`evidence/cfix4-prior-mutant-${m.name}.log`,import.meta.url),r.stdout+r.stderr);
  console.log(`RED ${m.name}: tests rejected mutant (exit ${r.status})`);
 }finally{writeFileSync(file,original);}
}
{
 const file=new URL('gate-paths.ps1',import.meta.url),original=readFileSync(file,'utf8');
 const mutated=original.replace('if($item.Attributes -band [IO.FileAttributes]::ReparsePoint)','if($false)');assert.notEqual(mutated,original);
 try {
  writeFileSync(file,mutated);
  const r=runLinuxFixture(pwsh,['-NoProfile','-File','scripts/windows/safety-check.ps1'],{encoding:'utf8',timeout:60000});
  assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,/Expected rejection: reparse ancestor under runs/);
  writeFileSync(new URL('evidence/cfix4-prior-mutant-accept-reparse-powershell.log',import.meta.url),r.stdout+r.stderr);
  console.log('RED accept-reparse-powershell: actual PowerShell ancestor guard rejected mutant');
 }finally{writeFileSync(file,original);}
}
