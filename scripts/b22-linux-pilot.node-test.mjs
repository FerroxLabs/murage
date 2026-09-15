import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseManifest, pilotPlan } from "./b22-linux-pilot.mjs";

const now=Date.parse("2026-09-15T00:00:00Z");
const valid=()=>({
  pilotId:"123456abcdef",authorityRef:"root-manifest-b22-fixture",sourceCommit:"a".repeat(40),sourceTree:"b".repeat(40),payloadArchiveSha256:"c".repeat(64),payloadArchive:"/private/tmp/murage-payload.tar",
  target:{sshAlias:"pilot-host",arch:"x86_64"},runtime:{nodePath:"/opt/node-v24/bin/node",nodeVersion:"v24.20.0"},
  service:{user:"murage",unitName:"murage",installRoot:"/opt/murage-pilot-123456abcdef",dataDir:"/var/lib/murage-pilot-123456abcdef/data",envFile:"/var/lib/murage-pilot-123456abcdef/server.env",serverPort:8799,doorPort:8813},
  network:{mode:"tailnet",tailnetTag:"tag:murage"},secretFiles:{tailscaleAuthKeyFile:"/root/murage-ts-authkey",noProviderKey:true},
  storage:{minFreeGiB:5},budget:{maxMinutes:60,maxCostUsd:0,cleanupDeadlineUtc:"2026-09-15T02:00:00Z"},
  cleanup:{removeData:true,tailnetLogout:true,allowReboot:false},evidenceDir:"/private/tmp/murage-b22-evidence",
});

test("a complete manifest yields bounded ordered operations without secret values",()=>{
  const parsed=parseManifest(valid(),now);assert.equal(parsed.ok,true,JSON.stringify(parsed.errors));
  const plan=pilotPlan(parsed.manifest);
  assert.deepEqual(plan.phases.map(phase=>phase.phase),["admit","host-preflight","stage-payload","setup","install-unit","readiness","restart","backup-restore","rollback","cleanup"]);
  const host=plan.phases.flatMap(phase=>phase.run).filter(command=>command.startsWith("ssh "));
  assert.ok(host.length>10);for(const command of host)assert.match(command,/^ssh -- 'pilot-host' 'timeout \d+ sh -c /);
  const text=JSON.stringify(plan);assert.doesNotMatch(text,/tskey-|sk-|AKIA|BEGIN/);assert.match(text,/--no-provider-key/);assert.match(text,/api\/health/);assert.doesNotMatch(text,/funnel/i);
  assert.match(text,/--no-install-tailscale/);assert.match(text,/no public share on this node/);assert.doesNotMatch(text,/sudo -u /);
  const installer=plan.phases.flatMap(phase=>phase.run).filter(command=>command.includes("installer/bin/murage.mjs"));
  assert.equal(installer.length,5);assert.doesNotMatch(text,/\/current\/installer\//);
  for(const command of installer)assert.ok(command.includes(`/opt/murage-pilot-123456abcdef/releases/${"a".repeat(40)}/installer/bin/murage.mjs`),command);
  const setup=plan.phases.find(phase=>phase.phase==="setup").run.join("\n");
  assert.match(setup,/sha256 \[0-9a-f\]\{64\}/);assert.match(setup,/sha256sum --check --strict - && sudo install -o root -g root -m 0644/);assert.match(setup,/sudo systemctl daemon-reload && sudo systemctl enable --now murage/);
  assert.equal(pilotPlan({...parsed.manifest,cleanup:{...parsed.manifest.cleanup,allowReboot:true}}).phases.some(phase=>phase.phase==="reboot"),true);
  assert.equal(JSON.stringify(pilotPlan({...parsed.manifest,cleanup:{removeData:false,tailnetLogout:false,allowReboot:false}})).includes("rm -rf"),false);
});

test("missing authority, unsafe identities and gated host facts refuse before any plan",()=>{
  const cases=[
    [m=>{m.service.dataDir="/";},/dedicated pilot data/],
    [m=>{m.service.installRoot="/opt";},/dedicated pilot root/],
    [m=>{m.target.sshAlias="-V";},/cannot be an option/],
    [m=>{delete m.pilotId;},/pilotId/],
    [m=>{delete m.authorityRef;},/authorityRef/],
    [m=>{m.runtime.nodeVersion="v22.21.1";},/nodeVersion must be >=24/],
    [m=>{m.service.user="root";},/service.user/],
    [m=>{m.service.doorPort=8799;},/must differ/],
    [m=>{m.service.unitName="murage-pilot";},/unitName must be murage/],
    [m=>{m.service.doorPort=8814;},/doorPort must be 8813/],
    [m=>{m.service.dataDir=m.service.installRoot+"/data";},/outside installRoot/],
    [m=>{m.service.dataDir="relative/data";},/dataDir must be absolute/],
    [m=>{m.network.mode="public";},/network.mode/],
    [m=>{m.network.funnel=true;},/public exposure field refused/],
    [m=>{m.secretFiles.providerKey="sk-live-inline-secret";},/inline secret refused/],
    [m=>{delete m.secretFiles.noProviderKey;},/providerKeyFile or noProviderKey/],
    [m=>{m.budget.cleanupDeadlineUtc="2026-09-14T23:00:00Z";},/future ISO time/],
    [m=>{delete m.cleanup.allowReboot;},/explicit booleans/],
    [m=>{m.sourceTree="HEAD";},/sourceTree/],
  ];
  for(const [mutate,expected] of cases){const m=valid();mutate(m);const parsed=parseManifest(m,now);assert.equal(parsed.ok,false);assert.match(parsed.errors.join("\n"),expected);}
});

test("the CLI exits 2 for an invalid manifest and prints only the plan for a valid one",()=>{
  const dir=mkdtempSync(join(tmpdir(),"murage-b22-pilot-"));
  try{
    const bad=join(dir,"bad.json");writeFileSync(bad,JSON.stringify({...valid(),runtime:{nodePath:"/usr/bin/node",nodeVersion:"v22.21.1"}}));
    assert.throws(()=>execFileSync(process.execPath,["scripts/b22-linux-pilot.mjs","plan",bad],{stdio:"pipe"}),error=>error.status===2&&/nodeVersion/.test(String(error.stderr)));
    const good=join(dir,"good.json");writeFileSync(good,JSON.stringify({...valid(),budget:{...valid().budget,cleanupDeadlineUtc:new Date(Date.now()+3600000).toISOString()}}));
    const output=JSON.parse(execFileSync(process.execPath,["scripts/b22-linux-pilot.mjs","plan",good],{encoding:"utf8"}));
    assert.equal(output.phases[0].phase,"admit");assert.equal(output.target,"pilot-host");
  }finally{rmSync(dir,{recursive:true,force:true});}
});


test("generated SSH commands preserve one remote command through local shell parsing",()=>{
  const dir=mkdtempSync(join(tmpdir(),"murage-b22-shell-"));
  try{
    // Fake ssh, timeout and sudo print their argv, so a real shell unwraps each quoted layer and the inner program itself is syntax-checked.
    for(const tool of ["ssh","timeout","sudo"])writeFileSync(join(dir,tool),'#!/bin/sh\nprintf \'%s\\n\' "$@"\n',{mode:0o700});
    const argvOf=command=>execFileSync("/bin/sh",["-c",command],{env:{...process.env,PATH:dir},encoding:"utf8"}).trimEnd().split("\n");
    const parse=program=>execFileSync("/bin/sh",["-n","-c",program],{stdio:"pipe"});
    const TIMEOUT=/^timeout \d+ sh -c '(?:[^']|'\\'')*'$/,SUDO=/^sudo sh -c '(?:[^']|'\\'')*'$/;
    const unwrap=(program,shape,length)=>{assert.match(program,shape);const argv=argvOf(program);assert.equal(argv.length,length);assert.deepEqual(argv.slice(-3,-1),["sh","-c"]);return argv.at(-1);};
    assert.throws(()=>parse(unwrap("timeout 60 sh -c 'out=$(; if then fi'",TIMEOUT,4)),"the fixture must reject a broken inner program");
    const plan=pilotPlan(valid());
    let programs=0,sudoPrograms=0,statusGuards=0,setupGuards=0;
    for(const phase of plan.phases){
      for(const command of phase.run.filter(value=>value.startsWith("ssh "))){
        const argv=argvOf(command);
        assert.equal(argv.length,3);assert.equal(argv[0],"--");assert.equal(argv[1],"pilot-host");
        parse(argv[2]);
        const program=unwrap(argv[2],TIMEOUT,4);parse(program);programs++;
        if(program.startsWith("sudo sh -c ")){parse(unwrap(program,SUDO,3));sudoPrograms++;}
        if(program.includes("proved it is this deployment"))statusGuards++;
        if(program.includes("sha256 [0-9a-f]{64}"))setupGuards++;
      }
    }
    assert.ok(programs>10);assert.equal(sudoPrograms,2);assert.equal(statusGuards,4);assert.equal(setupGuards,1);
    const stage=plan.phases.find(value=>value.phase==="stage-payload").run.join("\n");
    assert.match(stage,/sha256sum -c -/);assert.match(stage,/test ! -e/);
    const preflight=plan.phases.find(value=>value.phase==="host-preflight").run.join("\n");
    assert.match(preflight,/df -Pk .*\/opt.*\/var\/lib/);assert.doesNotMatch(preflight,/df -Pk [^\n]*murage-pilot-/);assert.match(preflight,/tailscale serve status --json/);assert.match(preflight,/sport = :8811/);assert.match(preflight,/sport = :8800/);
    const cleanup=plan.phases.find(value=>value.phase==="cleanup").run.join("\n");
    assert.match(cleanup,/\.pilot-owner/);assert.match(cleanup,/--one-file-system --/);assert.match(cleanup,/sport = :8800/);
    // Every required port (server, loopback webhook serverPort+1, companion control, door) is checked before setup and after cleanup.
    for(const text of [preflight,cleanup])for(const port of [8799,8800,8811,8813])assert.ok(text.includes(`sport = :${port} `),`port ${port}`);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("SYNTHETIC entrypoint: generated setup and status invoke the release CLI; the current symlink path would no-op",()=>{
  // SYNTHETIC: the real installer is never run here (its setup changes the machine). A stand-in installer/bin/murage.mjs
  // carries the real main guard verbatim, copied from installer/bin/murage.mjs:1547, and only when that guard is true
  // appends its argv (plus the MURAGE_* env it received) to a capture file. It prints nothing and exits 0.
  const MAIN_GUARD="const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);";
  assert.equal(readFileSync(new URL("../installer/bin/murage.mjs",import.meta.url),"utf8").split("\n").filter(line=>line===MAIN_GUARD).length,1,"the synthetic guard must be the installer's line verbatim");
  // realpath the tmp root: on macOS tmpdir() sits under the /var symlink, which would itself defeat the guard.
  const root=realpathSync(mkdtempSync(join(tmpdir(),"murage-b22-entry-")));
  try{
    assert.doesNotMatch(root,/'/);
    const m=valid(),plan=pilotPlan(m),PILOT="/opt/murage-pilot-123456abcdef",NODE_ROOT="/opt/node-v24";
    const release=`${root}${PILOT}/releases/${m.sourceCommit}`,cli=`${release}/installer/bin/murage.mjs`,currentCli=`${root}${PILOT}/current/installer/bin/murage.mjs`,capture=join(root,"capture.jsonl");
    mkdirSync(dirname(cli),{recursive:true});
    writeFileSync(cli,[
      "// SYNTHETIC stand-in for installer/bin/murage.mjs, written by scripts/b22-linux-pilot.node-test.mjs. Not the installer.",
      'import { appendFileSync } from "node:fs";','import { resolve } from "node:path";','import { fileURLToPath } from "node:url";',
      MAIN_GUARD,
      `if (isMain) appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(1), env: { MURAGE_PORT: process.env.MURAGE_PORT, MURAGE_BROWSER_PORT: process.env.MURAGE_BROWSER_PORT, MURAGE_DATA_DIR: process.env.MURAGE_DATA_DIR, MURAGE_ENV_FILE: process.env.MURAGE_ENV_FILE } }) + "\\n");`,
      "",
    ].join("\n"));
    symlinkSync(release,`${root}${PILOT}/current`); // the real layout: stage-payload runs ln -s <release> <installRoot>/current
    assert.equal(realpathSync(currentCli),cli);
    // Local shims only, no privilege and no network; each execs its arguments. ssh runs the remote command in local /bin/sh,
    // timeout drops its seconds, sudo applies VAR=value assignments through env, and node execs the running process.execPath.
    const bin=join(root,"shims"),q=value=>`'${value.replaceAll("'","'\\''")}'`;
    mkdirSync(bin);mkdirSync(`${root}${NODE_ROOT}/bin`,{recursive:true});
    writeFileSync(join(bin,"ssh"),'#!/bin/sh\n[ "$1" = "--" ] && [ "$2" = "pilot-host" ] || exit 97\nshift 2\nexec /bin/sh -c "$*"\n',{mode:0o700});
    writeFileSync(join(bin,"timeout"),'#!/bin/sh\ncase "$1" in ""|*[!0-9]*) exit 98;; esac\nshift\nexec "$@"\n',{mode:0o700});
    writeFileSync(join(bin,"sudo"),'#!/bin/sh\nexec /usr/bin/env "$@"\n',{mode:0o700});
    writeFileSync(`${root}${NODE_ROOT}/bin/node`,`#!/bin/sh\nexec ${q(process.execPath)} "$@"\n`,{mode:0o700});
    // The ONLY rewrite: the tmp root is prefixed to the absolute pilot root (/opt/murage-pilot-<id>) and Node root (/opt/node-v24).
    // Removing the tmp root again must give the generated command byte for byte.
    const rewrite=command=>{const local=command.replaceAll(PILOT,root+PILOT).replaceAll(NODE_ROOT,root+NODE_ROOT);assert.equal(local.replaceAll(root,""),command);return local;};
    const run=command=>spawnSync("/bin/sh",["-c",command],{env:{PATH:`${bin}:/usr/bin:/bin`},encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:60000});
    const take=()=>{if(!existsSync(capture))return[];const lines=readFileSync(capture,"utf8").trimEnd().split("\n").map(line=>JSON.parse(line));rmSync(capture);return lines;};
    const hosts=plan.phases.flatMap(phase=>phase.run).filter(command=>command.startsWith("ssh "));
    const setups=hosts.filter(command=>command.includes(" setup --non-interactive ")),statuses=hosts.filter(command=>command.includes(" status --service-user "));
    assert.equal(setups.length,1);assert.equal(statuses.length,4);assert.equal(new Set(statuses).size,1);
    assert.equal(plan.phases.find(phase=>phase.phase==="setup").run[0],setups[0]);assert.equal(plan.phases.find(phase=>phase.phase==="readiness").run[0],statuses[0]);
    const env={MURAGE_PORT:"8799",MURAGE_BROWSER_PORT:"8813",MURAGE_DATA_DIR:m.service.dataDir,MURAGE_ENV_FILE:m.service.envFile};
    // Generated setup through ssh -> timeout -> sh -c -> sudo -> node: the entrypoint really ran with the setup argv.
    // The stand-in prints nothing, so the setup output guard refuses (exit 1) although the CLI itself exited 0.
    let result=run(rewrite(setups[0]));
    assert.equal(result.status,1,`${result.stdout}${result.stderr}`);assert.ok(existsSync(capture),"setup must reach the entrypoint");
    assert.deepEqual(take(),[{argv:[cli,"setup","--non-interactive","--yes","--no-install-tailscale","--service-user","murage","--tailscale-auth-key-file","/root/murage-ts-authkey","--no-provider-key","--tailnet-tag","tag:murage","--https","--systemd"],env}]);
    // Generated status (identical in readiness, restart, backup-restore and rollback): the entrypoint really ran with the status argv.
    result=run(rewrite(statuses[0]));
    assert.equal(result.status,1,`${result.stdout}${result.stderr}`);assert.ok(existsSync(capture),"status must reach the entrypoint");
    assert.deepEqual(take(),[{argv:[cli,"status","--service-user","murage"],env}]);
    // CONTROL: the same generated setup with only its CLI path switched to <installRoot>/current/... reaches the same file
    // through the symlink, but the guard is false, so nothing is captured: the pre-correction recipe would have been a no-op.
    const viaCurrent=rewrite(setups[0]).replaceAll(cli,currentCli);
    assert.notEqual(viaCurrent,rewrite(setups[0]));
    result=run(viaCurrent);
    assert.equal(result.status,1,`${result.stdout}${result.stderr}`);assert.equal(existsSync(capture),false,"the current symlink path must not reach the guarded entrypoint");
    // CONTROL, direct: through the symlink the entrypoint exits 0 and prints nothing, so an exit code alone proves nothing ran.
    assert.equal(execFileSync(process.execPath,[currentCli,"status","--service-user","murage"],{env:{PATH:"/usr/bin:/bin"},encoding:"utf8"}),"");
    assert.equal(existsSync(capture),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
