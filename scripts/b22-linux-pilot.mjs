#!/usr/bin/env node
// B22 Linux single-operator pilot recipe (lane fixture). Offline only: it
// validates an explicit, root-authorised pilot manifest and prints the exact
// ordered operations. It never connects to a host, installs, starts or deletes
// anything, and secrets are referenced only by host file paths.
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

const hex=(length)=>new RegExp(`^[a-f0-9]{${length}}$`);
const SECRET_VALUE=/(tskey-|sk-[A-Za-z0-9]|AKIA[0-9A-Z]{8}|-----BEGIN|AGE-SECRET-KEY)/;
const absolute=(value)=>typeof value==="string"&&posix.isAbsolute(value)&&!value.includes("..")&&!/[\s'"$`\\]/.test(value);
const quote=(value)=>`'${String(value).replaceAll("'","'\\''")}'`;

/** Returns {ok, errors, manifest}. Every field is explicit; nothing is inferred. */
export function parseManifest(value,now=Date.now()){
  const errors=[],m=value&&typeof value==="object"?value:{};
  const need=(ok,message)=>{if(!ok)errors.push(message);};
  const walk=(node,path="")=>{if(node&&typeof node==="object")for(const [key,child] of Object.entries(node)){walk(child,`${path}${key}.`);if(/funnel|public/i.test(key))errors.push(`public exposure field refused: ${path}${key}`);}else if(typeof node==="string"&&SECRET_VALUE.test(node))errors.push(`inline secret refused at ${path.slice(0,-1)}`);};
  walk(m);
  need(hex(12).test(m.pilotId??""),"pilotId must be a fresh 12-hex pilot identity");
  need(typeof m.authorityRef==="string"&&m.authorityRef.trim().length>0,"authorityRef (root execution manifest id) is required");
  need(hex(40).test(m.sourceCommit??""),"sourceCommit must be a 40-hex commit");
  need(hex(40).test(m.sourceTree??""),"sourceTree must be the 40-hex seeded index tree");
  need(hex(64).test(m.payloadArchiveSha256??""),"payloadArchiveSha256 must be a 64-hex digest");
  need(absolute(m.payloadArchive),"payloadArchive must be an absolute local path");
  const t=m.target??{};
  need(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t.sshAlias??""),"target.sshAlias is required and cannot be an option");
  need(t.arch==="x86_64"||t.arch==="aarch64","target.arch must be x86_64 or aarch64");
  const r=m.runtime??{};
  need(absolute(r.nodePath),"runtime.nodePath must be absolute");
  const major=Number(/^v?(\d+)\./.exec(r.nodeVersion??"")?.[1]);
  need(Number.isInteger(major)&&major>=24,"runtime.nodeVersion must be >=24 (installer RUNTIME_FLOOR)");
  const s=m.service??{};
  need(/^[a-z_][a-z0-9_-]{0,31}$/.test(s.user??"")&&s.user!=="root","service.user must be an existing unprivileged account name");
  need(s.unitName==="murage","service.unitName must be murage (the installer stages only the fixed murage.service)");
  for(const key of ["installRoot","dataDir","envFile"])need(absolute(s[key]),`service.${key} must be absolute`);
  need(s.installRoot===`/opt/murage-pilot-${m.pilotId}`,"service.installRoot must be the dedicated pilot root");
  need(s.dataDir===`/var/lib/murage-pilot-${m.pilotId}/data`,"service.dataDir must be the dedicated pilot data path");
  need(s.envFile===`/var/lib/murage-pilot-${m.pilotId}/server.env`,"service.envFile must be inside the dedicated pilot root");
  if(absolute(s.dataDir)&&absolute(s.installRoot))need(!s.dataDir.startsWith(s.installRoot+"/")&&s.dataDir!==s.installRoot,"service.dataDir must be outside installRoot (releases are replaceable)");
  const ports=[s.serverPort,s.doorPort];
  need(ports.every(port=>Number.isInteger(port)&&port>=1024&&port<=65535),"service.serverPort and doorPort must be 1024-65535");
  need(s.serverPort!==s.doorPort,"service.serverPort and doorPort must differ");
  need(s.doorPort===8813,"service.doorPort must be 8813 (setup does not persist MURAGE_BROWSER_PORT, so the systemd unit serves the default door)");
  const n=m.network??{};
  need(n.mode==="tailnet","network.mode must be tailnet (no public listener)");
  need(/^tag:[a-z0-9-]{1,63}$/.test(n.tailnetTag??""),"network.tailnetTag is required");
  const k=m.secretFiles??{};
  need(absolute(k.tailscaleAuthKeyFile),"secretFiles.tailscaleAuthKeyFile must be an absolute host path");
  need(k.noProviderKey===true||absolute(k.providerKeyFile),"secretFiles.providerKeyFile or noProviderKey:true is required");
  const g=m.storage??{};
  need(Number.isInteger(g.minFreeGiB)&&g.minFreeGiB>=1&&g.minFreeGiB<=500,"storage.minFreeGiB must be 1-500");
  const b=m.budget??{};
  need(Number.isInteger(b.maxMinutes)&&b.maxMinutes>=5&&b.maxMinutes<=240,"budget.maxMinutes must be 5-240");
  need(typeof b.maxCostUsd==="number"&&b.maxCostUsd>=0,"budget.maxCostUsd is required");
  const deadline=Date.parse(b.cleanupDeadlineUtc??"");
  need(Number.isFinite(deadline)&&deadline>now,"budget.cleanupDeadlineUtc must be a future ISO time");
  const c=m.cleanup??{};
  need(typeof c.removeData==="boolean"&&typeof c.tailnetLogout==="boolean"&&typeof c.allowReboot==="boolean","cleanup.removeData, cleanup.tailnetLogout and cleanup.allowReboot must be explicit booleans");
  need(absolute(m.evidenceDir),"evidenceDir must be an absolute private local path");
  return{ok:errors.length===0,errors,manifest:errors.length?undefined:m};
}

/** Exact ordered operations. Host steps are bounded with timeout and run over the named alias. */
export function pilotPlan(m){
  const s=m.service,node=m.runtime.nodePath,release=`${s.installRoot}/releases/${m.sourceCommit}`,cli=`${release}/installer/bin/murage.mjs`;
  const host=(seconds,command)=>`ssh -- ${quote(m.target.sshAlias)} ${quote(`timeout ${seconds} sh -c ${quote(command)}`)}`;
  const dataRoot=posix.dirname(s.dataDir),archive=`/tmp/murage-${m.sourceCommit}.tar`;
  const hashCheck=`printf '%s  %s\\n' ${quote(m.payloadArchiveSha256)} ${quote(archive)} | sha256sum -c -`;
  const ownedRoots=`test ! -e ${quote(s.installRoot)} && test ! -L ${quote(s.installRoot)} && test ! -e ${quote(dataRoot)} && test ! -L ${quote(dataRoot)} && mkdir -m 755 ${quote(s.installRoot)} && mkdir -m 700 ${quote(dataRoot)} && chown ${s.user} ${quote(dataRoot)} && printf '%s' ${quote(m.pilotId)} > ${quote(s.installRoot+"/.pilot-owner")} && printf '%s' ${quote(m.pilotId)} > ${quote(dataRoot+"/.pilot-owner")}`;
  const cleanupOwned=`test ! -L ${quote(s.installRoot)} && test ! -L ${quote(dataRoot)} && test "$(cat ${quote(s.installRoot+"/.pilot-owner")})" = ${quote(m.pilotId)} && test "$(cat ${quote(dataRoot+"/.pilot-owner")})" = ${quote(m.pilotId)} && rm -rf --one-file-system -- ${quote(s.dataDir)} ${quote(release)}`;
  const env=`MURAGE_SERVER_ENTRY=${quote(`${s.installRoot}/current/dist-server/index.js`)} MURAGE_DATA_DIR=${quote(s.dataDir)} MURAGE_ENV_FILE=${quote(s.envFile)} MURAGE_PORT=${s.serverPort} MURAGE_BROWSER_PORT=${s.doorPort}`;
  const provider=m.secretFiles.noProviderKey?"--no-provider-key":`--provider-key-file ${quote(m.secretFiles.providerKeyFile)}`;
  // setup preserves arbitrary validated env keys; start reads this file on every launch.
  // Write as the service account, using the installer's existing private-file guards.
  const configureRuntime="const {inspectEnvFile,writeEnvFile}=await import(process.argv[1]);const [file,ui,fuigo]=process.argv.slice(2);const current=inspectEnvFile(file,{uid:process.getuid()});if(current.problems.length)throw Error('runtime env file refused');writeEnvFile(file,{...current.bag,MURAGE_STATIC_DIR:ui,MURAGE_FUIGO_DIR:fuigo});";
  const configureRuntimeRun=host(60,`sudo -u ${quote(s.user)} ${quote(node)} --input-type=module -e ${quote(configureRuntime)} ${quote(`${release}/installer/lib/env-file.mjs`)} ${quote(s.envFile)} ${quote(`${release}/dist`)} ${quote(`${release}/dist-native/fuigo/linux-${m.target.arch==="aarch64"?"arm64":"x64"}`)}`);
  const statusRun=`sudo ${env} ${quote(node)} ${quote(cli)} status --service-user ${s.user}`;
  const ready=[host(60,`out=$(${statusRun} 2>&1); rc=$?; printf '%s\\n' "$out"; test "$rc" -eq 0 && ! printf '%s' "$out" | grep -Fq '✗' && printf '%s' "$out" | grep -Fq 'proved it is this deployment' && printf '%s' "$out" | grep -Fq 'no public share on this node'`),host(20,`curl -fsS http://127.0.0.1:${s.serverPort}/api/health`)];
  const phases=[
    {phase:"admit",where:"local",run:[`git rev-parse HEAD # == ${m.sourceCommit}`,`git write-tree # == ${m.sourceTree}`,`shasum -a 256 ${quote(m.payloadArchive)} # == ${m.payloadArchiveSha256}`],expect:"authorityRef admitted, identities equal, now < cleanupDeadlineUtc"},
    {phase:"host-preflight",where:"host",run:[host(20,"uname -srm"),host(20,`${quote(node)} --version`),host(20,"systemctl --version"),host(20,`id ${s.user}`),host(20,`df -Pk ${quote(posix.dirname(s.installRoot))} ${quote(posix.dirname(dataRoot))}`),host(20,`ss -ltnH '( sport = :${s.serverPort} or sport = :${s.serverPort+1} or sport = :8811 or sport = :${s.doorPort} )'`),host(20,"tailscale version"),host(20,"tailscale status --json"),host(20,"tailscale serve status --json"),host(20,"test ! -e /etc/systemd/system/murage.service && test ! -L /etc/systemd/system/murage.service")],expect:`read-only; node >=24, account exists, >=${m.storage.minFreeGiB} GiB free on /opt and /var/lib, ports ${s.serverPort}/${s.serverPort+1} (loopback webhook receiver)/8811/${s.doorPort} unused, no murage.service installed, tailnet enrolment and serve config recorded`},
    {phase:"stage-payload",where:"host",run:[`scp -- ${quote(m.payloadArchive)} ${quote(`${m.target.sshAlias}:${archive}`)}`,host(120,hashCheck),host(300,`sudo sh -c ${quote(`${hashCheck} && ${ownedRoots} && mkdir -p ${quote(release)} && tar -xf ${quote(archive)} -C ${quote(release)} && ln -s ${quote(release)} ${quote(s.installRoot+"/current")}`)}`)],expect:"digest check succeeds before extraction; dedicated roots must not exist; ownership markers created; first pilot release has no previous current target"},
    {phase:"setup",where:"host",run:[host(600,`out=$(sudo ${env} ${quote(node)} ${quote(cli)} setup --non-interactive --yes --no-install-tailscale --service-user ${s.user} --tailscale-auth-key-file ${quote(m.secretFiles.tailscaleAuthKeyFile)} ${provider} --tailnet-tag ${m.network.tailnetTag} --https --systemd 2>&1); rc=$?; printf '%s\\n' "$out"; test "$rc" -eq 0 && printf '%s' "$out" | grep -Eq '^ *sha256 [0-9a-f]{64}$' && printf '%s' "$out" | grep -Fq 'sha256sum --check --strict - && sudo install -o root -g root -m 0644' && printf '%s' "$out" | grep -Fq 'sudo systemctl daemon-reload && sudo systemctl enable --now murage'`)],expect:"the CLI runs from the real release path (the installer's main-module check does nothing through the current symlink and still exits 0); rc 0 and the output has the printed 'sha256 <64-hex>' line, the sha256sum-checked install command and the daemon-reload/enable command; tailscale already installed (setup never installs it); env file 0600 owned by service user; record the printed commands and unit sha256"},
    {phase:"install-unit",where:"host",run:[configureRuntimeRun,"# run only the first three commands setup printed (sha256-checked install to /etc/systemd/system/murage.service, staging removal, daemon-reload and enable --now murage); never the fourth, journalctl -u murage -f, which does not exit; record them and the installed unit sha256",host(60,`sudo systemctl enable --now ${s.unitName}`)],expect:"before starting the service, server.env preserves setup settings and contains the exact release UI and Fuigo paths (mode 0600, service-owned); unit active; installed unit sha256 equals the printed sha256; no public share"},
    {phase:"readiness",where:"host",run:ready,expect:"root status output has no ✗ line and contains 'proved it is this deployment's door' and 'no public share on this node' (status exits 0 even when a check fails); /api/health 200 on loopback"},
    {phase:"restart",where:"host",run:[host(60,`sudo systemctl restart ${s.unitName}`),...ready,host(60,`sudo journalctl -u ${s.unitName} --since '-15 min' --no-pager`)],expect:"ready again; data-dir digest unchanged except SQLite sidecars; journal saved to evidence"},
    ...(m.cleanup.allowReboot?[{phase:"reboot",where:"host",run:[host(30,"sudo systemctl reboot"),"# wait for ssh, bounded by budget.maxMinutes",...ready],expect:"unit comes back without login"}]:[]),
    {phase:"backup-restore",where:"host",run:[host(120,`sudo systemctl stop ${s.unitName}`),"# encrypted capture with the pinned linux-x64 age tool into a new path (installation-recovery backup-encrypted), then inspect and restore-encrypted-new into a separate paused path",host(60,`sudo systemctl start ${s.unitName}`),...ready],expect:"verified archive sha, paused restore markers, original preserved under the SQLite-sidecar rule, service ready again"},
    {phase:"rollback",where:"host",run:["# the unit ExecStart names the release path setup resolved (installer cliPath), not current/, so re-pointing current alone does not switch releases; a switch needs setup re-run from that release plus its printed install; first pilot release: restart only",host(60,`sudo systemctl restart ${s.unitName}`),...ready],expect:"same release and data dir after restart (a first pilot has no previous release); ready"},
    {phase:"cleanup",where:"host",run:[host(60,`sudo systemctl disable --now ${s.unitName}`),host(60,`sudo systemctl status ${s.unitName} --no-pager # expect inactive`),...(m.cleanup.tailnetLogout?[host(60,"sudo tailscale logout")]:[]),...(m.cleanup.removeData?[host(300,`sudo sh -c ${quote(cleanupOwned)}`)]:[]),host(20,`ss -ltnH '( sport = :${s.serverPort} or sport = :${s.serverPort+1} or sport = :8811 or sport = :${s.doorPort} )' # expect empty`),host(20,"tailscale serve status --json # record; the installer has no removal for its handler to 127.0.0.1:8813"),"# list residue the installer does not remove, for owner disposition: /etc/systemd/system/murage.service, the env file and its .previous copy, the tailnet serve handler, the /tmp payload archive, the Node runtime directory, the service account"],expect:"unit inactive, ports closed, only marker-matched dedicated pilot data/release removed; control directories retained; residue listed for owner disposition; before cleanupDeadlineUtc"},
  ];
  return{authorityRef:m.authorityRef,target:m.target.sshAlias,budget:m.budget,evidenceDir:m.evidenceDir,phases};
}

if(import.meta.url===pathToFileURL(process.argv[1]??"").href){
  const [command,file]=process.argv.slice(2);
  if(command!=="plan"||!file){console.error("usage: b22-linux-pilot.mjs plan <manifest.json>");process.exit(2);}
  let value;try{value=JSON.parse(readFileSync(file,"utf8"));}catch{console.error("manifest unreadable");process.exit(2);}
  const parsed=parseManifest(value);
  if(!parsed.ok){console.error(JSON.stringify({ok:false,errors:parsed.errors},null,1));process.exit(2);}
  console.log(JSON.stringify(pilotPlan(parsed.manifest),null,1));
}
