import {runNodeFixture} from './native-launcher.mjs';
// Six binding MAIN mutants; restore each production file before the next run.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {runLinuxFixture} from './native-launcher.mjs';
const pwsh=process.env.WINSCEN_PWSH || '.test-tmp/cfix4-winscen/pwsh/pwsh';
const cases=[
 {name:'allow-breakaway',file:'owned-process.ps1',change:s=>s.replace('limits.basic.flags=0x2000;','limits.basic.flags=0x2000 | 0x800;')},
 {name:'delete-unprefixed-task',file:'ownership.ps1',change:s=>s.replace('if(Test-RunPrefix $item.id $Prefix)','if($true)'),ps:true},
 {name:'desktop-https-dispatch',file:'packaged-scenario.mjs',change:s=>s.replace("   await begin('browser');","   await begin('browser');\n   await page.evaluate(url=>window.muragebox.openExternal(url),'https://127.0.0.1:18919/page'); // row:'https-opened'")},
 {name:'finalize-inside-child',file:'scenario-common.ps1',change:s=>s.replace("  $assertions | ConvertTo-Json -Depth 20", "  Move-Item -LiteralPath $pending -Destination $Receipt\n  $assertions | ConvertTo-Json -Depth 20")},
 {name:'preserve-running-wrapper',file:'ownership.ps1',change:s=>s.replace('  $deadline=(Get-WrapperNow $Now).AddSeconds(60)',"  if($Item.state -eq 4){return} # unsafe running wrapper preservation\n  $deadline=(Get-WrapperNow $Now).AddSeconds(60)"),ps:'p11b-check.ps1'},
 {name:'native-outside-job',file:'owned-process.ps1',change:s=>s.replace('  Invoke-OwnedNative -File $File -Arguments $arguments -TimeoutSeconds 30', '  $process = [Diagnostics.Process]::Start($File,$arguments); $process.Kill()')},
];
for(const m of cases){
 const file=new URL(m.file,import.meta.url),original=readFileSync(file,'utf8'),changed=m.change(original);assert.notEqual(changed,original);
 try {
  writeFileSync(file,changed);
  const r=m.ps?runLinuxFixture(pwsh,['-NoProfile','-File',`scripts/windows/${typeof m.ps==='string'?m.ps:'ownership-check.ps1'}`],{encoding:'utf8',timeout:60000}):runNodeFixture(['--test','scripts/windows/ownership.node-test.mjs','scripts/windows/p11b.node-test.mjs'],{encoding:'utf8',timeout:60000});
  assert.equal(r.signal,null);assert.notEqual(r.status,0,`SURVIVED ${m.name}`);
  assert.match(r.stdout+r.stderr,/ASSERTION:|AssertionError|ERR_ASSERTION/,'assertion failure required');
  writeFileSync(new URL(`evidence/cfix4-mutant-${m.name}.log`,import.meta.url),r.stdout+r.stderr);
  console.log(`RED ${m.name} (assertion failure, exit ${r.status})`);
 }finally{writeFileSync(file,original);}
}
