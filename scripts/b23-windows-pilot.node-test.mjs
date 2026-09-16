import assert from "node:assert/strict";
import test from "node:test";
import { parseManifest, pilotPlan } from "./b23-windows-pilot.mjs";
import { createBackgroundLogin } from "../electron/background-login.mjs";

const now=Date.parse("2026-09-15T00:00:00Z");
const valid=()=>({
  authorityRef:"root-manifest-b23-fixture",sourceCommit:"a".repeat(40),
  artifact:{ciRunId:123456,installerSha256:"b".repeat(64),installerName:"Murage-0.1.53-setup.exe",publisher:"Ferrox Labs, LLC"},
  host:{name:"pilot-win",osBuild:"10.0.26200"},user:{account:"murage-pilot",sid:"S-1-5-21-1-2-3-1001",elevated:false},
  session:{kind:"rdp",sessionId:2},startupMode:"login-item",evidenceDir:"C:\\Users\\murage-pilot\\murage-b23-evidence",
  budget:{maxMinutes:60,maxCostUsd:0,cleanupDeadlineUtc:"2026-09-15T02:00:00Z"},
  cleanup:{uninstall:true,removeUserData:false,allowReboot:false,allowSignOut:true},
});

test("a complete manifest yields the ordered standard-user session recipe and never a service or task",()=>{
  const parsed=parseManifest(valid(),now);assert.equal(parsed.ok,true,JSON.stringify(parsed.errors));
  const plan=pilotPlan(parsed.manifest);
  assert.deepEqual(plan.phases.map(phase=>phase.phase),["admit","session-preflight","installer-identity","standard-user-install","installed-identity","foreground-launch","startup-login-item","sign-out-sign-in","backup-boundaries","stop-and-preserve","cleanup"]);
  const text=JSON.stringify(plan);
  assert.doesNotMatch(text,/Register-ScheduledTask|schtasks|New-Service|sc\.exe|Stop-Process|RunAs|-Verb/);
  assert.match(text,/PARKED/);assert.match(text,/Get-AuthenticodeSignature/);assert.equal(plan.requiresRealWindows,true);
  assert.equal(text.includes("Remove-Item"),false);
  const preflight=plan.phases.find(phase=>phase.phase==="session-preflight").run.join("\n");
  assert.match(preflight,/whoami \/groups \| Select-String -SimpleMatch 'S-1-5-32-544'/);assert.ok(preflight.includes("New-Item -ItemType Directory -Force -Path 'C:\\Users\\murage-pilot\\murage-b23-evidence'"));
  const stop=plan.phases.find(phase=>phase.phase==="stop-and-preserve").run;
  const off=stop.findIndex(command=>command.includes("turn off 'Start when I sign in'")),quit=stop.findIndex(command=>command.includes("quit Murage"));
  assert.ok(off>=0&&off<quit,"sign-in startup is turned off in-app before quitting when uninstall is approved");
  assert.match(text,/Start when I sign in/);assert.match(text,/Closed-app scheduling unavailable/);assert.match(text,/murage server on http:\/\/127\.0\.0\.1/);assert.match(text,/S-1-15-2-2/);
  assert.doesNotMatch(text,/absent after uninstall/);
  const admit=plan.phases.find(phase=>phase.phase==="admit").expect;
  assert.match(admit,/no retry/);assert.match(admit,/after any stop from standard-user-install onward, still do stop-and-preserve and cleanup/);
  const boundary=plan.phases.find(phase=>phase.phase==="backup-boundaries");
  assert.ok(boundary.expect.includes("'Closed-app scheduling unavailable'")&&boundary.expect.includes("'Scheduled backup requires a supported packaged app with its verified backup tool.'"),"either backup-tool state is accepted and recorded");
  assert.match(boundary.expect,/refuse and stop only if a 'Prepare closed-app job' or 'Register prepared job' control is offered/);
  assert.ok(boundary.run[0].includes("'Scheduled application-data backups'"));assert.doesNotMatch(JSON.stringify(boundary),/General → Backup/);
  const kept=pilotPlan({...parsed.manifest,cleanup:{uninstall:false,removeUserData:false,allowReboot:false,allowSignOut:false}});
  assert.equal(JSON.stringify(kept).includes("turn off 'Start when I sign in'"),false);
  const withData=pilotPlan({...parsed.manifest,cleanup:{uninstall:true,removeUserData:true,allowReboot:true,allowSignOut:false}});
  assert.equal(withData.phases.some(phase=>phase.phase==="reboot"),true);assert.equal(withData.phases.some(phase=>phase.phase==="sign-out-sign-in"),false);assert.match(JSON.stringify(withData),/Remove-Item/);
});

test("elevation, Session 0, unsupported startup modes and unsigned inputs refuse before any plan",()=>{
  const cases=[
    [m=>{delete m.authorityRef;},/authorityRef/],
    [m=>{m.user.elevated=true;},/Limited token/],
    [m=>{m.user.account="Administrator";},/standard \(non-admin\)/],
    [m=>{m.session.sessionId=0;},/sessionId must be > 0/],
    [m=>{m.session.kind="service";},/Session 0/],
    [m=>{m.startupMode="scheduled-task";},/login-item/],
    [m=>{m.startupMode="service";},/login-item/],
    [m=>{m.artifact.installerName="Murage-win.zip";},/NSIS \.exe/],
    [m=>{m.artifact.installerName="Murage.exe";},/Murage-<version>-setup\.exe/],
    [m=>{m.artifact.installerName="Uninstall Murage.exe";},/Murage-<version>-setup\.exe/],
    [m=>{m.artifact.installerName="Murage Setup 0.1.53.exe";},/Murage-<version>-setup\.exe/],
    [m=>{m.artifact.publisher="Unknown";},/signing subject/],
    [m=>{m.artifact.ciRunId=0;},/ciRunId/],
    [m=>{m.user.note="sk-live-inline-secret";},/inline secret refused/],
    [m=>{m.cleanup.removeUserData=true;m.cleanup.uninstall=false;},/requires cleanup.uninstall/],
    [m=>{m.budget.cleanupDeadlineUtc="2026-09-14T00:00:00Z";},/future ISO time/],
  ];
  for(const [mutate,expected] of cases){const m=valid();mutate(m);const parsed=parseManifest(m,now);assert.equal(parsed.ok,false);assert.match(parsed.errors.join("\n"),expected);}
});


test("spaced installer names remain one PowerShell expression at every call site",()=>{
 const spaced=valid();spaced.artifact.installerName="Murage Setup 0.1.53.exe";
 const plan=pilotPlan(spaced);
 const identity=plan.phases.find(p=>p.phase==="installer-identity").run;
 const install=plan.phases.find(p=>p.phase==="standard-user-install").run[0];
 for(const command of [...identity,install])assert.ok(command.includes("(Join-Path $env:USERPROFILE 'Downloads\\Murage Setup 0.1.53.exe')"));
});

test("real installer and evidence exports stay one parenthesized PowerShell expression",()=>{
 const plan=pilotPlan(valid());
 const identity=plan.phases.find(p=>p.phase==="installer-identity").run;
 const install=plan.phases.find(p=>p.phase==="standard-user-install").run[0];
 for(const command of [...identity,install])assert.ok(command.includes("(Join-Path $env:USERPROFILE 'Downloads\\Murage-0.1.53-setup.exe')"));
 const stop=plan.phases.find(p=>p.phase==="stop-and-preserve").run.join("\n");
 for(const name of ["profile-after-stop.csv","workspace-after-stop.csv"])assert.ok(stop.includes(`-Path (Join-Path 'C:\\Users\\murage-pilot\\murage-b23-evidence' '${name}')`));
 assert.ok(stop.includes("$env:USERPROFILE\\.murage"));
 for(const phase of plan.phases)for(const command of phase.run)assert.doesNotMatch(command,/'\\/);
});

test("preflight refuses a UAC-filtered administrator and cleanup checks the exact product login-item value without deleting registry values",async()=>{
 const plan=pilotPlan(valid()),phase=name=>plan.phases.find(p=>p.phase===name);
 const preflight=phase("session-preflight");
 assert.ok(preflight.run[0].includes("IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"));
 assert.equal(preflight.run[1],"whoami /groups | Select-String -SimpleMatch 'S-1-5-32-544'","the filtered-token IsInRole check is backed by the token-group SID check");
 assert.ok(preflight.expect.includes("Admin=False; the whoami /groups line prints nothing (a UAC-filtered administrator still lists S-1-5-32-544)")&&preflight.expect.includes("refuse and stop otherwise"));
 const file="(Join-Path 'C:\\Users\\murage-pilot\\murage-b23-evidence' 'login-item-value.txt')";
 const save=phase("startup-login-item").run.find(command=>command.includes("GetValueNames()"));
 assert.equal(save,`@((Get-Item 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').GetValueNames() | Where-Object { $_ -cmatch '^Murage-[0-9a-f]{16}$' }) | Set-Content -Path ${file}; Get-Content -Path ${file}`);
 const pattern=new RegExp(save.match(/-cmatch '([^']+)'/)[1]);
 const calls=[],app={getLoginItemSettings:()=>({openAtLogin:false}),setLoginItemSettings:options=>calls.push(options)};
 const login=createBackgroundLogin({platform:"win32",app,installed:true,primaryProfile:true,profileDir:"C:\\Users\\murage-pilot\\.murage",userDataDir:"C:\\Users\\murage-pilot\\AppData\\Roaming\\Murage",executable:"C:\\Users\\murage-pilot\\AppData\\Local\\Programs\\Murage\\Murage.exe"});
 await login.write(true);await login.write(false);
 assert.equal(calls.length,2);assert.match(calls[0].name,pattern);
 assert.equal(calls[1].name,calls[0].name,"turning sign-in startup off in-app targets the same exact value");
 assert.deepEqual(calls.map(options=>options.openAtLogin),[true,false]);
 for(const wrong of ["murage-0123456789abcdef","Murage-0123456789ABCDEF","Murage-0123456789abcde","Murage-0123456789abcdef0"])assert.doesNotMatch(wrong,pattern);
 const cleanup=phase("cleanup"),uninstall=cleanup.run.findIndex(command=>command.includes("Uninstall Murage.exe")),check=cleanup.run.findIndex(command=>command.includes(`Get-Content -Path ${file}`));
 assert.ok(uninstall>=0&&check>uninstall,"the exact value is checked after uninstall");
 assert.ok(cleanup.run[check].includes("Present=(($n -cmatch '^Murage-[0-9a-f]{16}$') -and ($null -ne $k.GetValue($n)))"));
 assert.match(cleanup.expect,/Recorded=True and Present=False for the exact name saved at startup-login-item/);assert.match(cleanup.expect,/this recipe deletes no registry value/);
 const kept=pilotPlan({...valid(),cleanup:{uninstall:false,removeUserData:false,allowReboot:false,allowSignOut:false}}).phases.find(p=>p.phase==="cleanup");
 assert.ok(kept.run.some(command=>command.includes(`Get-Content -Path ${file}`)));assert.match(kept.expect,/Recorded=True and Present=True/);
 const registryWrite=/Remove-ItemProperty|Clear-ItemProperty|Set-ItemProperty|New-ItemProperty|\breg(?:\.exe)?\s+(?:delete|add)|Remove-Item\s+['"]?HKCU/i;
 for(const flags of [{uninstall:false,removeUserData:false},{uninstall:true,removeUserData:false},{uninstall:true,removeUserData:true}])for(const allowReboot of [false,true])for(const allowSignOut of [false,true]){
  const variant=valid();variant.cleanup={...flags,allowReboot,allowSignOut};
  const parsed=parseManifest(variant,now);assert.equal(parsed.ok,true,JSON.stringify(parsed.errors));
  const commands=pilotPlan(parsed.manifest).phases.flatMap(p=>p.run);
  assert.doesNotMatch(commands.join("\n"),registryWrite);
  for(const command of commands.filter(c=>c.includes("Remove-Item")))assert.ok(command.startsWith("Remove-Item \"$env:APPDATA\\Murage\" -Recurse"));
 }
});
