import { expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditReleaseCapabilities, WINDOWS_OIDC_JOBS } from './release-capability-audit.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const file = '.github/workflows/windows-qualsign.yml';
const clean = () => parse(readFileSync(join(root,file),'utf8'));
const job = doc => doc.jobs['sign-collector'];
const verifyJob = doc => doc.jobs['verify-collector'];
const step = (doc,id) => Object.values(doc.jobs).flatMap(j => j.steps).find(s => s.id === id);
const nodeSource = id => step(clean(),id).run.match(/node --input-type=module -e @'\n([\s\S]*?)\n'@/)[1];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const helperPath = 'infra/windows-signing/qualsign/Write-QualsignReceipt.ps1';
const helper = () => readFileSync(join(root,helperPath),'utf8');
const files = [file,'.github/workflows/release.yml','.github/workflows/prepare-release.yml','.github/workflows/cla.yml'];
const audit = doc => auditReleaseCapabilities(root,new Map([[file,stringify(doc)]]),files).errors;
const scrub = `$ErrorActionPreference = 'Stop'
$config = if ($env:AZURE_CONFIG_DIR) { $env:AZURE_CONFIG_DIR } else { Join-Path $HOME '.azure' }
try {
  $PSNativeCommandUseErrorActionPreference = $false
  & az logout
  $logoutExit = $LASTEXITCODE
  & az account clear
  $clearExit = $LASTEXITCODE
  $PSNativeCommandUseErrorActionPreference = $true
  $accounts = (& az account list --all --output json | Out-String).Trim()
  $listExit = $LASTEXITCODE
} finally {
  if (Test-Path -LiteralPath $config) { Remove-Item -LiteralPath $config -Recurse -Force }
}
if ($listExit -ne 0 -or $accounts -cne '[]') { throw 'Azure credentials remain' }
if (Test-Path -LiteralPath $config) { throw 'Azure config survived' }
`;
function contract(doc) {
  expect(doc.on).toEqual({push:{branches:['ci/try-*']}});
  expect(doc.permissions).toEqual({contents:'read'});
  expect(doc.concurrency).toEqual({group:'windows-qualsign-${{ github.ref }}','cancel-in-progress':false});
  expect(Object.keys(doc.jobs)).toEqual(['sign-collector','verify-collector']);
  const j=job(doc), v=verifyJob(doc);
  expect(j.permissions).toEqual({contents:'read','id-token':'write'});
  expect(j.environment).toBe('windows-qualsign');
  expect(v.permissions).toEqual({contents:'read'}); expect(v.environment).toBeUndefined();
  expect(v.needs).toBe('sign-collector'); expect(j.needs).toBeUndefined();
  expect(j.if).toBe("startsWith(github.event.head_commit.message, 'QUALSIGN collector ')");
  expect(v.if).toBeUndefined();
  for (const member of [j,v]) {
    expect(member['runs-on']).toBe('windows-latest'); expect(member['timeout-minutes']).toBe(30);
    expect(member.env).toBeUndefined(); expect(member.uses).toBeUndefined();
    expect(member['continue-on-error']).toBeUndefined();
    for (const s of member.steps) {
      if (s.uses) expect(s.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
      expect(s.if).toBe(s.id==='scrub'?'always()':undefined);
      expect(s['continue-on-error']).toBeUndefined();
    }
  }
  expect(JSON.stringify(doc)).not.toMatch(/secrets\s*[.\[]|GH_TOKEN|release-guard\.mjs|gh\s+release|RELEASES_PAT|murage-releases|azure-client-secret|"creds"/i);
  expect(j.steps.map(s=>s.id??s.uses?.split('@')[0])).toEqual(['guard','actions/checkout','trees','actions/setup-dotnet','sdk','restore','build','presign','azure/login','sign','scrub','actions/upload-artifact']);
  expect(v.steps.map(s=>s.id??s.uses?.split('@')[0])).toEqual(['token-absence','actions/checkout','binding','actions/download-artifact','verify','receipt','actions/upload-artifact']);
  for (const member of [j,v]) expect(member.steps[1]).toEqual({uses:'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',with:{ref:'${{ github.sha }}','persist-credentials':false,'fetch-depth':2}});
  expect(j.steps[3]).toEqual({uses:'actions/setup-dotnet@baa11fbfe1d6520db94683bd5c7a3818018e4309',with:{'dotnet-version':'10.0.115'}});
  expect(step(doc,'sdk').run).toContain('"rollForward":"disable"');
  expect(step(doc,'restore').run).toContain('Push-Location "$env:RUNNER_TEMP/qualsign-sdk-selection"');
  expect(step(doc,'restore').run).toContain('--locked-mode');
  expect(step(doc,'restore').env).toEqual({NUGET_PACKAGES:'${{ runner.temp }}/qualsign-nuget-packages',NUGET_HTTP_CACHE_PATH:'${{ runner.temp }}/qualsign-nuget-http'});
  for(const name of ['NUGET_PACKAGES','NUGET_HTTP_CACHE_PATH']) expect(step(doc,'restore').run).toContain(`New-Item -ItemType Directory -Path $env:${name}`);
  expect(step(doc,'restore').run).toContain('BaseIntermediateOutputPath=$env:RUNNER_TEMP\\obj\\');
  expect(step(doc,'restore').run).toContain(`${helperPath} -Mode Packs`);
  expect(step(doc,'build').run).toContain('WINDOWS_WITNESS_NATIVE_CORE_BUILT');
  expect(step(doc,'build').run).toContain("-SdkVersion '10.0.115'");
  for (const [id,mode] of [['trees','Bind'],['presign','PreSign'],['verify','Verify'],['receipt','Receipt']]) expect(step(doc,id).run.trim()).toBe(`./${helperPath} -Mode ${mode}`);
  expect(step(doc,'binding').env).toEqual({QUALSIGN_BIND:'${{ toJSON(needs.sign-collector.outputs) }}'});
  expect(step(doc,'binding').run).toContain(`${helperPath} -Mode Bind`);
  expect(step(doc,'token-absence').run.trim()).toBe("if ($env:ACTIONS_ID_TOKEN_REQUEST_URL -or $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN -or $env:AZURE_FEDERATED_TOKEN) { throw 'Verification job holds signing credential' }");
  expect(j.steps[8]).toEqual({uses:'azure/login@eec3c95657c1536435858eda1f3ff5437fee8474',with:{'client-id':'${{ vars.QUALSIGN_AZURE_CLIENT_ID }}','tenant-id':'${{ vars.QUALSIGN_AZURE_TENANT_ID }}','allow-no-subscriptions':true}});
  expect(step(doc,'sign').uses).toBe('Azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82');
  expect(step(doc,'sign').with).toEqual({endpoint:'https://eus.codesigning.azure.net','signing-account-name':'ferrox-labs-signing','certificate-profile-name':'ferroxlabs','files-folder':'${{ runner.temp }}/tosign','files-folder-filter':'exe','file-digest':'SHA256','timestamp-digest':'SHA256',timeout:300,...Object.fromEntries(['environment','workload-identity','managed-identity','shared-token-cache','visual-studio','azure-powershell','interactive-browser'].map(n=>[`exclude-${n}-credential`,true])),'exclude-azure-cli-credential':false});
  expect(step(doc,'scrub').run).toBe(scrub);
  const identityNames=['QUALSIGN_EXPECTED_SUBJECT','QUALSIGN_EXPECTED_ISSUER_PREFIX','QUALSIGN_EXPECTED_ROOT_CN','QUALSIGN_EXPECTED_ROOT_SHA256','QUALSIGN_EXPECTED_EKU'];
  expect(step(doc,'verify').env).toEqual(Object.fromEntries(identityNames.map(name=>[name,`\${{ vars.${name} }}`])));
  for (const name of identityNames) expect(JSON.stringify(doc).split(`vars.${name} }}`).length-1).toBe(1);
  expect(JSON.stringify(doc)).not.toMatch(/QUALSIGN_EXPECTED_ISSUER[\s}"']/);
  const expectedOutput={dev_sha:'guard',dev_sha12:'guard',collector:'trees',signingProcess:'trees',processApi:'trees',plan:'trees',workflow:'trees',helper:'trees',lock_sha256:'trees',packs_sha256:'restore',sdk_version:'sdk',dotnet_sha256:'sdk',unsigned_sha256:'presign'};
  expect(j.outputs).toEqual(Object.fromEntries(Object.entries(expectedOutput).map(([key,id])=>[key,`\${{ steps.${id}.outputs.${key} }}`])));
  expect(v.outputs).toEqual({signed_sha256:'${{ steps.verify.outputs.signed_sha256 }}',receipt_sha256:'${{ steps.receipt.outputs.receipt_sha256 }}'});
  for (const [member,name,path] of [[j,'qualsign-signed-${{ steps.guard.outputs.dev_sha12 }}-${{ github.run_attempt }}','${{ runner.temp }}/tosign/witness-collector.exe'],[v,'qualsign-collector-${{ needs.sign-collector.outputs.dev_sha12 }}-${{ github.run_attempt }}','${{ runner.temp }}/tosign/witness-collector.exe\n${{ runner.temp }}/tosign/qualsign-receipt.json\n']]) expect(member.steps.at(-1)).toEqual({uses:'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',with:{name,path,'if-no-files-found':'error','retention-days':1}});
  expect(v.steps[3]).toEqual({uses:'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',with:{name:'qualsign-signed-${{ needs.sign-collector.outputs.dev_sha12 }}-${{ github.run_attempt }}',path:'${{ runner.temp }}/tosign'}});
}

it('qualification workflow has the complete fixed signing contract',()=>contract(clean()));
it('NativeAOT producer publishes without restore and fetches no compiler',()=>{
  const build=readFileSync(join(root,'infra/windows-signing/collector/Build.ps1'),'utf8');
  expect(build).toContain("'--no-restore'"); expect(build).not.toMatch(/\b(?:Invoke-WebRequest|Invoke-RestMethod|DownloadFile|DownloadString|curl|wget)\b|dotnet-install/i);
});
it.each([
 ['M-Q1 contents write',d=>{job(d).permissions.contents='write';}],
 ['extra permission',d=>{job(d).permissions.actions='read';}],
 ['M-Q2 secret',d=>{step(d,'sign').with['azure-client-id']='${{ secrets.AZURE_CLIENT_ID }}';}],
 ['M-Q3 job env',d=>{job(d).env={PUBLIC:'neutral'};}],
 ['M-Q4 workflow OIDC',d=>{d.permissions['id-token']='write';}],
 ['M-Q5 missing environment',d=>{delete job(d).environment;}],
 ['M-Q5 different environment',d=>{job(d).environment='other';}],
 ...['workflow_dispatch','pull_request','pull_request_target','workflow_run','workflow_call'].map(trigger=>[`M-Q6 ${trigger}`,d=>{d.on[trigger]={};}]),
 ['M-Q7 tag pin',d=>{job(d).steps[1].uses='actions/checkout@v4';}],
 ['M-Q8 retention',d=>{job(d).steps.at(-1).with['retention-days']=2;}],
 ['M-Q8 extra upload',d=>{verifyJob(d).steps.at(-1).with.path+='extra.exe\n';}],
 ['M-Q9 order',d=>{const s=job(d).steps; [s[7],s[9]]=[s[9],s[7]];}],
 ['M-Q10 secret input',d=>{step(d,'sign').with['azure-client-secret']='neutral';}],
 ['M-Q10 creds input',d=>{job(d).steps[8].with.creds='neutral';}],
 ['M-QS18 no scrub',d=>{job(d).steps=job(d).steps.filter(s=>s.id!=='scrub');}],
 ['M-QS18 conditional scrub',d=>{delete step(d,'scrub').if;}],
 ['M-QS19 persisted checkout',d=>{job(d).steps[1].with['persist-credentials']=true;}],
 ['M-QS20 wrong account',d=>{step(d,'sign').with['signing-account-name']='other';}],
 ['M-QS21 other credential',d=>{step(d,'sign').with['exclude-environment-credential']=false;}],
 ['M-QS23/R2-8 unlocked restore',d=>{step(d,'restore').run=step(d,'restore').run.replace('--locked-mode','');}],
 ['M-QS25 other qualification environment',d=>{job(d).environment='windows-sac-qualification';}],
 ['M-QS27 extra signed type',d=>{step(d,'sign').with['files-folder-filter']='exe,dll';}],
 ['M-QS28/R2-6 third job',d=>{d.jobs.other={steps:[{run:'echo neutral'}]};}],
 ['M-QS17 release dependency',d=>{job(d).needs=['stage'];}],
 ...['node scripts/release-guard.mjs stage','gh release create neutral','echo RELEASES_PAT'].map(run=>[`M-Q11 ${run}`,d=>{step(d,'build').run=run;}]),
 ['R2-1 extra run after signing',d=>{job(d).steps.push({run:'echo neutral'});}],
 ['R2-1 extra uses after signing',d=>{job(d).steps.push({uses:'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'});}],
 ['R2-2 verify OIDC',d=>{verifyJob(d).permissions['id-token']='write';}],
 ['R2-3 verify environment',d=>{verifyJob(d).environment='windows-qualsign';}],
 ['R2-4 verify missing needs',d=>{delete verifyJob(d).needs;}],
 ...['verify','receipt'].map(id=>[`R2-5 ${id} moved into signing job`,d=>{job(d).steps.splice(10,0,step(d,id)); verifyJob(d).steps=verifyJob(d).steps.filter(s=>s.id!==id);}]),
 ['R2-7 token absence removed',d=>{verifyJob(d).steps.shift();}],
])('%s is RED beside GREEN contract',(_name,mutate)=>{contract(clean()); const d=clean(); mutate(d); expect(()=>contract(d)).toThrow();});

it('G-A admits exactly the qualification key and kills permission/environment mutants',()=>{
 expect(WINDOWS_OIDC_JOBS.has(`${file}:sign-collector`)).toBe(true); expect(audit(clean())).toEqual([]);
});
it.each([
 ['contents write',d=>{job(d).permissions.contents='write';}],
 ['extra permission',d=>{job(d).permissions.actions='read';}],
 ['missing environment',d=>{delete job(d).environment;}],
 ['other environment',d=>{job(d).environment='other';}],
 ['unlisted pair',d=>{d.jobs.other=job(d);delete d.jobs['sign-collector'];}],
 ['object environment',d=>{verifyJob(d).environment={name:'windows-qualsign'};}],
 ['case-folded environment',d=>{verifyJob(d).environment='WINDOWS-QUALSIGN';}],
])('G-A paired admission mutant: %s',(_name,mutate)=>{const d=clean();mutate(d);expect(audit(d).some(e=>e.file===file)).toBe(true);expect(audit(clean())).toEqual([]);});
it('M-Q12 removed audit member fails beside admitted control',()=>{
 expect(audit(clean())).toEqual([]); const removed=WINDOWS_OIDC_JOBS.delete(`${file}:sign-collector`);
 try {expect(audit(clean()).some(e=>e.file===file&&e.path.endsWith('permissions'))).toBe(true);} finally {if(removed)WINDOWS_OIDC_JOBS.add(`${file}:sign-collector`);}
});

function scratch(run) {
  const dir=mkdtempSync(join(tmpdir(),'qualsign-'));
  try { return run(dir); } finally { rmSync(dir,{recursive:true,force:true}); }
}
function execute(id,dir,extra={},source=nodeSource(id)) {
  return spawnSync(process.execPath,['--input-type=module','-e',source],{
    cwd:dir,encoding:'utf8',env:{...process.env,RUNNER_TEMP:dir,GITHUB_EVENT_PATH:join(dir,'event.json'),
      GITHUB_OUTPUT:join(dir,'output'),GITHUB_STEP_SUMMARY:join(dir,'summary'),...extra},
  });
}
const devSha='a'.repeat(40), publicSha='b'.repeat(40);
function event(dir,message=`QUALSIGN collector ${devSha}`,id=publicSha) {
  writeFileSync(join(dir,'event.json'),JSON.stringify({head_commit:{message,id}}));
}
it('guard runs before checkout and rejects malformed subjects, SHAs and refs', () => scratch(dir => {
  const env={GITHUB_SHA:publicSha,GITHUB_REF_NAME:'ci/try-012345abcdef'};
  event(dir); expect(execute('guard',dir,env).status).toBe(0);
  expect(readFileSync(join(dir,'output'),'utf8')).toBe(`dev_sha=${devSha}\ndev_sha12=${devSha.slice(0,12)}\n`);
  for (const message of [`QUALSIGN collector ${devSha.slice(1)}`,`QUALSIGN collector ${devSha} extra`,`QUALSIGN collector ${'G'.repeat(40)}`,'CI try neutral']) {
    event(dir,message); expect(execute('guard',dir,env).status).not.toBe(0);
  }
  event(dir); expect(execute('guard',dir,{...env,GITHUB_REF_NAME:'main'}).status).not.toBe(0);
  event(dir,`QUALSIGN collector ${devSha}`,devSha); expect(execute('guard',dir,env).status).not.toBe(0);
}));


function selfcheck(group,source) {
 return scratch(dir=>{
  const steps=join(dir,'steps.json'); writeFileSync(steps,JSON.stringify(Object.values(clean().jobs).flatMap(j=>j.steps).filter(s=>s.run)));
  const extra=[]; if(source!==undefined) {const path=join(dir,'helper.ps1'); writeFileSync(path,source);extra.push('-HelperPath',path);}
  const result=spawnSync(process.env.QUALSIGN_TEST_PWSH??'pwsh',['-NoProfile','-File',join(root,'scripts/windows-qualsign-workflow.selfcheck.ps1'),'-StepsJson',steps,'-Scratch',dir,'-Group',group,...extra],{cwd:root,encoding:'utf8'});
  expect(result.stdout+result.stderr).not.toContain('ParserError'); if(source===undefined) expect(result.status,result.stdout+result.stderr).toBe(0); else expect(result.status,result.stdout+result.stderr).not.toBe(0);
 });
}
it('pre-sign parser rejects certificate offset/size, malformed PE and extra images',()=>selfcheck('Pe'));
it('M-QS13 embedded certificate gate rejects catalog-only, malformed tables and surviving OIDC',()=>selfcheck('Tokens'));
it('M-QS18 runner OIDC reinjection stays RED in verification and kills removal of the credential gate',()=>selfcheck('Scrub'));
it('receipt binds exact dev SHA and all bound real git objects across a scrubbed public SHA',()=>selfcheck('Receipt'));
it('M-QS14 issuer/EKU, M-QS15 CN-only, M-QS16 SDK location, R2-14 identity mutants and W9 public chain',()=>selfcheck('Identity'));
it('R2-10/R2-11 exact download pack set and hashes',()=>selfcheck('Packs'));
it('W4 committed restore lock has only Windows target sections',()=>{
 const lock=JSON.parse(readFileSync(join(root,'infra/windows-signing/collector/packages.lock.json')));
 expect(lock.dependencies['net10.0-windows7.0/win-x64']).toBeDefined();
 expect(JSON.stringify(lock)).not.toMatch(/linux-|osx-|musl/);
 expect(readFileSync(join(root,'infra/windows-signing/collector/WitnessCollector.csproj'),'utf8')).toContain('<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>');
 const pins=JSON.parse(readFileSync(join(root,'infra/windows-signing/qualsign/packs.sha512.json')));
 expect(pins.length).toBeGreaterThan(0); for(const pin of pins) {expect(pin.id).not.toMatch(/linux|osx|musl/); expect(pin.sha512).toMatch(/^[A-Za-z0-9+/]{86}==$/);}
 expect(JSON.parse(readFileSync(join(root,'infra/windows-signing/collector/global.json')))).toEqual({sdk:{version:'10.0.115',rollForward:'disable',allowPrerelease:false}});
 for (const target of Object.values(lock.dependencies)) for (const dependency of Object.values(target)) expect(dependency.resolved).toBe('10.0.15');
 for (const pin of pins) expect(pin.version).toBe('10.0.15');
});

it.each([
 ['M-QS14 issuer mismatch bypass','Identity',"(Get-RdnValue $Leaf.IssuerName '2.5.4.10') -cne 'Microsoft Corporation'",'$false'],
 ['M-QS14 EKU mismatch bypass','Identity',"if ($Ekus -cnotcontains $oid)",'if ($false)'],
 ['M-QS15 CN-only subject','Identity',"(Get-RdnValue $Leaf.SubjectName '2.5.4.10') -cne $env:QUALSIGN_EXPECTED_SUBJECT",'$false'],
 ['M-QS16 workspace signtool','Identity',"if (-not $root -or $signtool.StartsWith",'if ($false -and $signtool.StartsWith'],
 ['R2-10 pack hash bypass','Packs',"if ($metadata.contentHash -cne $pin[0].sha512)",'if ($false)'],
 ['R2-11 exact pack set bypass','Packs',"$actual.Count -ne $expected.Count",'$false'],
])('%s implementation mutant is killed beside GREEN helper',(_name,group,search,replacement)=>{
 selfcheck(group); const original=helper(), mutant=original.replace(search,replacement); expect(mutant).not.toBe(original); selfcheck(group,mutant);
});

function helperContract(source) {
 for (const text of [
  "$signature.Status -ne 'NotSigned'",
  "${env:ProgramFiles(x86)}\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe",
  '& $signtool verify /pa /all /v /tw $file',
  "if ($LASTEXITCODE -ne 0) { throw 'Signtool verification failed' }",
  "if ($signature.Status -ne 'Valid' -or $null -eq $leaf)",
  '$chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Online',
  '$chain.ChainPolicy.VerificationFlags = [Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag',
  "if (-not $chain.Build($leaf)) { throw 'Approved online certificate chain required' }",
  "if ($signed -ceq $bind.unsignedSha256) { throw 'Signing did not change bytes' }",
 ]) expect(source).toContain(text);
 expect(source).not.toMatch(/IgnoreNotTimeValid|NoCheck|IgnoreEndRevocationUnknown|IgnoreCertificateAuthorityRevocationUnknown|IgnoreRootRevocationUnknown/);
}
it('M-QS8/M-QS13/M-QS16 preserves signtool, Authenticode and fail-closed online chain gates',()=>helperContract(helper()));
it.each([
 ['signtool invocation','& $signtool verify /pa /all /v /tw $file'],
 ['signtool exit',"if ($LASTEXITCODE -ne 0) { throw 'Signtool verification failed' }"],
 ['pinned SDK path',"${env:ProgramFiles(x86)}\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe"],
 ['online revocation','$chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Online'],
 ['no verification flags','$chain.ChainPolicy.VerificationFlags = [Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag'],
 ['failed chain',"if (-not $chain.Build($leaf)) { throw 'Approved online certificate chain required' }"],
])('%s gate removal is RED beside GREEN helper contract',(_name,text)=>{
 const source=helper(); helperContract(source);const mutant=source.replace(text,'');expect(mutant).not.toBe(source);expect(()=>helperContract(mutant)).toThrow();
});
it('M-QS24 release workflows do not adopt the interim qualification checker',()=>{
 for(const name of ['release.yml','package-win.yml']) expect(readFileSync(join(root,'.github/workflows',name),'utf8')).not.toMatch(/Write-QualsignReceipt|QUALSIGN_EXPECTED_|qualsign-collector-v1/);
});
