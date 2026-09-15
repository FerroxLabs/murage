#!/usr/bin/env node
// B23 Windows standard-user/session pilot recipe (lane fixture). Offline only:
// validates an explicit, root-authorised manifest and prints ordered PowerShell
// operations for an owner-run interactive session. It never registers tasks,
// creates sessions or services, installs, or dispatches a signed build.
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";

const SECRET_VALUE=/(tskey-|sk-[A-Za-z0-9]|AKIA[0-9A-Z]{8}|-----BEGIN|AGE-SECRET-KEY)/;
const winPath=(value)=>typeof value==="string"&&win32.isAbsolute(value)&&/^[A-Za-z]:\\/.test(value)&&!value.includes("..")&&!/["'`$]/.test(value);
const ps=(value)=>`'${String(value).replaceAll("'","''")}'`;

export function parseManifest(value,now=Date.now()){
  const errors=[],m=value&&typeof value==="object"?value:{};
  const need=(ok,message)=>{if(!ok)errors.push(message);};
  const walk=(node,path="")=>{if(node&&typeof node==="object")for(const [key,child] of Object.entries(node))walk(child,`${path}${key}.`);else if(typeof node==="string"&&SECRET_VALUE.test(node))errors.push(`inline secret refused at ${path.slice(0,-1)}`);};
  walk(m);
  need(typeof m.authorityRef==="string"&&m.authorityRef.trim().length>0,"authorityRef (root execution manifest id) is required");
  need(/^[a-f0-9]{40}$/.test(m.sourceCommit??""),"sourceCommit must be a 40-hex commit");
  const a=m.artifact??{};
  need(Number.isSafeInteger(a.ciRunId)&&a.ciRunId>0,"artifact.ciRunId from the admitted signed package-win run is required");
  need(/^[a-f0-9]{64}$/.test(a.installerSha256??""),"artifact.installerSha256 is required");
  need(typeof a.installerName==="string"&&/^Murage-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-setup\.exe$/.test(a.installerName),"artifact.installerName must be the NSIS .exe named Murage-<version>-setup.exe (electron-builder.yml nsis.artifactName; the ZIP tree lacks the app-package RX grant)");
  need(a.publisher==="Ferrox Labs, LLC","artifact.publisher must be the exact signing subject");
  const h=m.host??{};
  need(typeof h.name==="string"&&/^[A-Za-z0-9-]{1,63}$/.test(h.name),"host.name is required");
  need(/^10\.0\.\d{5}$/.test(h.osBuild??""),"host.osBuild (for example 10.0.26200) is required");
  const u=m.user??{};
  need(/^[A-Za-z0-9._-]{1,20}$/.test(u.account??"")&&!/^(administrator|admin|system)$/i.test(u.account??""),"user.account must be a named standard (non-admin) account");
  need(/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(u.sid??""),"user.sid must be the account's domain/local SID");
  need(u.elevated===false,"user.elevated must be false: installs and checks run with a Limited token");
  const s=m.session??{};
  need(s.kind==="console"||s.kind==="rdp","session.kind must be console or rdp (Session 0 is not an interactive desktop)");
  need(Number.isInteger(s.sessionId)&&s.sessionId>0,"session.sessionId must be > 0");
  need(m.startupMode==="login-item","startupMode must be login-item: scheduled-task and service modes do not exist in product code");
  need(winPath(m.evidenceDir),"evidenceDir must be an absolute Windows path in the user profile");
  const b=m.budget??{};
  need(Number.isInteger(b.maxMinutes)&&b.maxMinutes>=5&&b.maxMinutes<=120,"budget.maxMinutes must be 5-120");
  need(typeof b.maxCostUsd==="number"&&b.maxCostUsd>=0,"budget.maxCostUsd is required");
  const deadline=Date.parse(b.cleanupDeadlineUtc??"");
  need(Number.isFinite(deadline)&&deadline>now,"budget.cleanupDeadlineUtc must be a future ISO time");
  const c=m.cleanup??{};
  need(typeof c.uninstall==="boolean"&&typeof c.removeUserData==="boolean"&&typeof c.allowReboot==="boolean"&&typeof c.allowSignOut==="boolean","cleanup.uninstall, removeUserData, allowReboot and allowSignOut must be explicit booleans");
  if(c.removeUserData===true)need(c.uninstall===true,"cleanup.removeUserData requires cleanup.uninstall");
  return{ok:errors.length===0,errors,manifest:errors.length?undefined:m};
}

export function pilotPlan(m){
  const installer=`(Join-Path $env:USERPROFILE ${ps(`Downloads\\${m.artifact.installerName}`)})`,evidence=ps(m.evidenceDir),inEvidence=(name)=>`(Join-Path ${evidence} ${ps(name)})`;
  const token="$id=[Security.Principal.WindowsIdentity]::GetCurrent();$p=[Security.Principal.WindowsPrincipal]$id;[pscustomobject]@{Sid=$id.User.Value;Admin=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);Session=(Get-Process -Id $PID).SessionId}";
  const ready="Get-Content \"$env:APPDATA\\Murage\\logs\\server.log\" -Tail 50";
  const runKey="'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'",loginName="'^Murage-[0-9a-f]{16}$'",loginFile=inEvidence("login-item-value.txt");
  const phases=[
    {phase:"admit",run:[`# root manifest ${m.authorityRef}; signed run ${m.artifact.ciRunId}; source ${m.sourceCommit}`],expect:"authority admitted and now < cleanupDeadlineUtc; one owner session, no retry; stop at the first unexpected result; after any stop from standard-user-install onward, still do stop-and-preserve and cleanup exactly as generated (manifest-approved removals only) before cleanupDeadlineUtc and record the result; skip cleanup only if Murage cannot be quit from its own menu"},
    {phase:"session-preflight",run:[token,"whoami /groups | Select-String -SimpleMatch 'S-1-5-32-544'","[Environment]::OSVersion.Version","query user","$env:SESSIONNAME",`New-Item -ItemType Directory -Force -Path ${evidence} | Select-Object FullName`],expect:`Sid=${m.user.sid}; Admin=False; the whoami /groups line prints nothing (a UAC-filtered administrator still lists S-1-5-32-544); Session=${m.session.sessionId} (${m.session.kind}: SESSIONNAME Console or RDP-Tcp#n); OS ${m.host.osBuild}; evidence folder created; refuse and stop otherwise`},
    {phase:"installer-identity",run:[`(Get-FileHash ${installer} -Algorithm SHA256).Hash.ToLower()`,`Get-AuthenticodeSignature ${installer} | Select-Object Status,@{n='Subject';e={$_.SignerCertificate.Subject}}`],expect:`hash ${m.artifact.installerSha256}; Status Valid; subject contains ${m.artifact.publisher}`},
    {phase:"standard-user-install",run:[`Start-Process -FilePath ${installer} -ArgumentList '/S' -Wait -PassThru | Select-Object ExitCode`,"Get-Item \"$env:LOCALAPPDATA\\Programs\\Murage\\Murage.exe\" | Select-Object FullName,Length"],expect:"exit 0 without a UAC prompt; per-user install location; no machine-wide change"},
    {phase:"installed-identity",run:["Get-AuthenticodeSignature \"$env:LOCALAPPDATA\\Programs\\Murage\\Murage.exe\" | Select-Object Status","icacls \"$env:LOCALAPPDATA\\Programs\\Murage\""],expect:"Valid signature; icacls lists ALL RESTRICTED APPLICATION PACKAGES (S-1-15-2-2) with (OI)(CI)(RX) from customInstall, not only ALL APPLICATION PACKAGES"},
    {phase:"foreground-launch",run:["Start-Process \"$env:LOCALAPPDATA\\Programs\\Murage\\Murage.exe\"",ready],expect:"window visible in this session; server.log has an '[out] murage server on http://127.0.0.1:<port>' line; no provider/model call"},
    {phase:"startup-login-item",run:["# Settings → General → Startup & background: turn on 'Start when I sign in' (owner click)","Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' | Format-List",`@((Get-Item ${runKey}).GetValueNames() | Where-Object { $_ -cmatch ${loginName} }) | Set-Content -Path ${loginFile}; Get-Content -Path ${loginFile}`],expect:"one value named Murage-<16 lowercase hex> (sha256 of the workspace path, electron/background-login.mjs) whose command is the installed Murage.exe with --murage-login --murage-data-dir <workspace> --murage-user-data <userData>; the second line saves that exact name to login-item-value.txt in the evidence folder and prints exactly one name; this Run location is Electron's Windows behaviour and is not established from repository source: if no Murage- value is listed, record Task Manager → Startup apps and stop (no scheduled task, no service)"},
    ...(m.cleanup.allowSignOut?[{phase:"sign-out-sign-in",run:["# owner signs out and back in to the same account/session type",token,ready],expect:"app starts from the login item in the new interactive session; data preserved"}]:[]),
    ...(m.cleanup.allowReboot?[{phase:"reboot",run:["Restart-Computer # owner-approved","# after sign-in:",token,ready],expect:"no start before interactive sign-in; login item starts it afterwards"}]:[]),
    {phase:"backup-boundaries",run:["# Settings → General → 'Scheduled application-data backups': record which state appears (it depends on whether the packaged backup tool verified at startup, which B23 does not qualify)","# in-app encrypted backup/restore journey remains PARKED (B20 Windows native): do not run it here"],expect:"either (a) under 'When Murage is closed' the status reads 'Closed-app scheduling unavailable' (a trailing ' in this window' also counts), or (b) the card reads 'Scheduled backup requires a supported packaged app with its verified backup tool.' with no 'When Murage is closed' section; record which (any other status is recorded as seen); refuse and stop only if a 'Prepare closed-app job' or 'Register prepared job' control is offered; no backup attempted"},
    {phase:"stop-and-preserve",run:[...(m.cleanup.uninstall?["# Settings → General → Startup & background: turn off 'Start when I sign in' first (the uninstaller does not remove sign-in entries)"]:[]),"# quit Murage from its own menu; never force-kill it","Get-Process Murage -ErrorAction SilentlyContinue",`Get-ChildItem "$env:APPDATA\\Murage" | Select-Object Name,LastWriteTime | Export-Csv -NoTypeInformation -Path ${inEvidence("profile-after-stop.csv")}`,`Get-ChildItem "$env:USERPROFILE\\.murage" | Select-Object Name,LastWriteTime | Export-Csv -NoTypeInformation -Path ${inEvidence("workspace-after-stop.csv")}`],expect:"no Murage process remains; app profile and workspace entries preserved"},
    {phase:"cleanup",run:[...(m.cleanup.uninstall?["Start-Process \"$env:LOCALAPPDATA\\Programs\\Murage\\Uninstall Murage.exe\" -ArgumentList '/S' -Wait"]:[]),...(m.cleanup.removeUserData?["Remove-Item \"$env:APPDATA\\Murage\" -Recurse # only because cleanup.removeUserData=true"]:[]),`$n=[string](Get-Content -Path ${loginFile} -ErrorAction SilentlyContinue);$k=Get-Item ${runKey};[pscustomobject]@{Name=$n;Recorded=($n -cmatch ${loginName});Present=(($n -cmatch ${loginName}) -and ($null -ne $k.GetValue($n)))}`,"Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' | Format-List"],expect:`only manifest-approved removals; ${m.cleanup.uninstall?"Recorded=True and Present=False for the exact name saved at startup-login-item, and no Murage- value remains in the listing (sign-in startup was turned off in-app before quitting; the uninstaller does not remove it)":"Recorded=True and Present=True: the Murage- value remains (no uninstall approved)"}; Recorded=False means startup-login-item saved no single name (for example a stop before it): record the listing; if an unexpected Murage- value remains, record it and leave it: this recipe deletes no registry value (owner/root disposition); %USERPROFILE%\\.murage is never deleted by this recipe; finished before cleanupDeadlineUtc`},
  ];
  return{authorityRef:m.authorityRef,host:m.host.name,account:m.user.account,budget:m.budget,phases,requiresRealWindows:true};
}

if(import.meta.url===pathToFileURL(process.argv[1]??"").href){
  const [command,file]=process.argv.slice(2);
  if(command!=="plan"||!file){console.error("usage: b23-windows-pilot.mjs plan <manifest.json>");process.exit(2);}
  let value;try{value=JSON.parse(readFileSync(file,"utf8"));}catch{console.error("manifest unreadable");process.exit(2);}
  const parsed=parseManifest(value);
  if(!parsed.ok){console.error(JSON.stringify({ok:false,errors:parsed.errors},null,1));process.exit(2);}
  console.log(JSON.stringify(pilotPlan(parsed.manifest),null,1));
}
