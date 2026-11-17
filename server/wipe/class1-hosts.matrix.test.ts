// SPDX-License-Identifier: AGPL-3.0-or-later
// Class 1: every host / wrapper / interpreter spelling that carries a command or source text.
// Hand-written from bash(1), zsh(1), dash(1), ksh(1), fish(1), tcsh(1), pwsh/powershell -?, cmd /?, su(1),
// runuser(1), sudo(8), doas(1), run0(1), pkexec(1), env(1), nice(1), ionice(1), timeout(1), chrt(1),
// taskset(1), stdbuf(1), nohup(1), setsid(1), flock(1), watch(1), script(1), man(1), python(1), perl(1),
// ruby(1), node(1), php(1). Never generated from server/wipe/hosts.ts.
import {expect,it} from 'vitest';
import {row,runMatrix,type Row} from './matrix.fixture.ts';
type Payload=[e:'C'|'R',text:string];
const sh:Payload[]=[['C','rm -rf /etc'],['C','rm -rf ~'],['C','X=1 rm -rf /home'],['R','rm -rf ./build'],['R','echo c']];
const csh:Payload[]=[['C','rm -rf /etc'],['C','rm -rf ~'],['R','rm -rf ./build'],['R','echo c']];
const plain:Payload[]=[['C','rm -rf /etc'],['C','rm -rf /home/u'],['R','rm -rf ./build'],['R','echo c']];
const py:Payload[]=[['C','import shutil; shutil.rmtree("/home/u")'],['C','import os; os.system("rm -rf /etc")'],['R','import shutil; shutil.rmtree("dist")'],['R','print("c")']];
const pl:Payload[]=[['C','system("rm -rf /etc")'],['R','system("rm -rf ./build")'],['R','print "c"']];
const rb:Payload[]=[['C','system("rm -rf /etc")'],['C','require "fileutils"; FileUtils.rm_rf("/home/u")'],['R','FileUtils.rm_rf("dist")'],['R','puts "c"']];
const js:Payload[]=[['C','require("fs").rmSync("/home/u",{recursive:true,force:true})'],['C','require("child_process").execSync("rm -rf /etc")'],['R','require("fs").rmSync("dist",{recursive:true,force:true})'],['R','console.log("c")']];
const php:Payload[]=[['C','system("rm -rf /etc");'],['R','echo "c";']];
const pw:Payload[]=[['C','Remove-Item -Recurse -Force /home'],['C','Remove-Item -r -fo /etc'],['R','Remove-Item -Recurse -Force ./build'],['R','Write-Output c']];
const rows:Row[]=[];
/** `@` in a template is the payload in single quotes; `#` is the bare payload. inert = the spelling never executes it. */
const add=(templates:string[],payloads:Payload[],inert=false)=>{for(const t of templates)for(const [e,text] of payloads)rows.push(row(inert?'R':e,t.replace('@',"'"+text+"'").replace('#',text)));};

// POSIX-family shells: -c takes the first non-option word; options may precede or follow -c.
for(const s of ['sh','bash','rbash','zsh','dash','ksh','mksh','oksh','ash','yash','posh'])
 add([`${s} -c @`,`${s} -ec @`,`${s} -c -e @`,`${s} -xc @`,`${s} -e -u -c @`,`${s} -c @ arg0 arg1`,`/bin/${s} -c @`,`${s} -o errexit -c @`,`${s} +x -c @`],sh);
add(['bash --norc -c @','bash --noprofile --norc -c @','bash --rcfile /dev/null -c @','bash --init-file /dev/null -c @','bash -O extglob -c @','bash --posix -c @','bash -l -c @','bash --login -c @','bash -euo pipefail -c @','bash -c @ -- x','bash -lc @','bash -o pipefail -o errexit -c @'],sh);
add(['zsh --no-rcs -c @','zsh -f -c @','zsh --emulate sh -c @','zsh --no-globalrcs -c @','zsh -o errexit -c @','zsh --errexit -c @','zsh -fc @'],sh);
add(['busybox sh -c @','busybox ash -c @','ksh93 -c @'],sh);
// An option the reader does not know: the words after it are still inspected.
add(['bash --frob -c @','zsh --frob-x -c @','sh --frob -c @','dash -Z -c @'],sh);
// Standard input as the script.
add(['echo @ | sh','echo @ | bash','echo @ | bash -s','bash <<< @','bash -s <<< @','sh -s arg <<< @'],sh);
// Never executes the string: syntax check, help, a script file with the text as its argument.
add(['bash -n -c @','sh -n -c @','zsh -n -c @','bash --help -c @','bash --version','bash ./script.sh @','sh script.sh -c @','bash -c "echo c" @'],sh,true);
// fish: every -c and -C runs, attached or not; -n / --no-execute only parses.
add(['fish -c @','fish --command=@','fish --command @','fish -C @','fish --init-command=@','fish --init-command @','fish -c "echo c" -c @','fish -N -c @','fish --no-config -c @','fish -ic @','fish -c@','fish --private -c @','fish -d 3 -c @'],sh);
add(['fish -n -c @','fish --no-execute -c @'],sh,true);
// csh / tcsh.
add(['csh -c @','tcsh -c @','csh -fc @','tcsh -f -c @','csh -ec @','tcsh -fec @'],csh);
// PowerShell from a POSIX shell. A bare first word is a command in Windows PowerShell 5.1 and a script file in pwsh.
add(['pwsh -c @','pwsh -Command @','pwsh -comm @','pwsh -NoProfile -Command @','pwsh -nop -c @','pwsh -nop -noni -ep Bypass -c @','pwsh -ExecutionPolicy Bypass -Command @','pwsh -NoLogo -NonInteractive -Command @','pwsh -CommandWithArgs @','powershell -Command @','powershell -c @','powershell @','powershell -NoProfile @','powershell -nop -ep Bypass @','powershell.exe -c @','pwsh -NoExit -Command @','pwsh -WindowStyle Hidden -Command @','pwsh -OutputFormat Text -c @'],pw);
add(['pwsh @','pwsh -File @','pwsh -nop -File @','pwsh -f @'],pw,true);
// su / runuser: the command string goes to the target user's shell, wherever the user name stands.
add(['su -c @','su -c @ root','su root -c @','su --command=@ root','su --command @','su --command @ root','su -c@ root','su - root -c @','su -l root -c @','su -s /bin/bash -c @ root','su --shell=/bin/sh -c @','su --session-command=@','su --session-command @ root','su -lc @ root','su --comm=@ root','su -m -c @','su -p root -c @','su - -c @','runuser -l root -c @','runuser root -c @','runuser -c @ root','runuser --command=@ -l root','runuser - root -c @'],sh);
add(['runuser -u root -- #','runuser -u nobody #','runuser --user=root -- #'],plain);
// sudo and friends run a program; sudo -s / -i hand the joined words to a shell.
add(['sudo #','sudo -u root #','sudo -- #','sudo -E -H #','sudo -s #','sudo -i #','sudo -s -- #','sudo --user=root #','sudo -n -k #','sudo -D /tmp #','sudo -g wheel -u root #','sudo -EH -u root #','sudo --preserve-env -u root #','sudo --frob #','sudo -iu root #','sudo --shell #','sudo --login #','sudo -C 3 #','sudo -p pw: #','sudo -uroot #','sudo -b #',
 'doas #','doas -u root #','doas -n #','doas -n -u root #','run0 #','run0 --user=root #','run0 -u root #','pkexec #','pkexec --user root #'],plain);
add(['sudo sh -c @','sudo -u root bash -c @','sudo -E bash -lc @','doas sh -c @','sudo -s @','sudo -i @','sudo su -c @','sudo su - root -c @','sudo -u root -i sh -c @','pkexec sh -c @','run0 bash -c @'],sh);
add(['sudo -l #','sudo -V #','sudo --list #','sudo --help #','sudo -v'],plain,true);
// Program wrappers.
add(['env #','env -i #','env FOO=1 #','env -u FOO #','env -i FOO=1 BAR=2 #','env -- #','env --ignore-environment #','env --unset=FOO #','nice #','nice -n 5 #','nice -5 #','nice --adjustment=5 #','nice -n5 #','ionice -c3 #','ionice -c 2 -n 7 #','ionice --class 3 #','timeout 5 #','timeout -s KILL 5 #','timeout --signal=KILL 5s #','timeout -k 1 5 #','timeout --preserve-status 5 #','timeout --kill-after=2 5m #','chrt -f 10 #','chrt --rr 5 #','chrt -b 0 #','taskset 0x1 #','taskset -c 0 #','taskset --cpu-list 0-3 #','stdbuf -oL #','stdbuf -o L #','stdbuf --output=L -eL #','stdbuf -i0 -o0 -e0 #','nohup #','setsid #','setsid -w #','setsid --wait #','setsid -f #','time #','time -p #','command #','command -p #','command -- #','exec #','exec -a x #','exec -c #','exec -cl #','flock /tmp/l #','flock -n /tmp/l #','flock -x -w 5 /tmp/l #','flock --timeout 5 /tmp/l #','flock -n -E 1 /tmp/l #','watch #','watch -n 5 #','watch -d -n 1 #','watch --interval=2 #','watch -x #','nice nohup timeout 5 #','sudo env FOO=1 nice -n 5 #','env -i sudo -u root timeout 5 nohup #','systemd-run --scope #','caffeinate -i #'],plain);
add(['env -S @','env --split-string=@','env -i -S @','flock /tmp/l -c @','flock -n /tmp/l -c @','flock /tmp/l --command @','watch @','watch -n 5 @','script -c @','script -qc @ /dev/null','script --command=@','script -q -c @ /dev/null','script --command @ /dev/null','man -P @ ls','man --pager=@ ls','env sh -c @','nice -n 5 bash -c @','timeout 5 sh -c @','nohup sh -c @','setsid bash -c @','time sh -c @','exec sh -c @','command sh -c @','stdbuf -oL sh -c @','env -i bash --norc -c @','taskset -c 0 sh -c @','chrt -f 10 sh -c @','ionice -c3 sh -c @','flock /tmp/l sh -c @'],sh);
add(['command -v #','command -V #','env --help #','timeout --help #','nice --version','env --version #'],plain,true);
// Interpreters: -c / -e source in any legal bundle, attached or separate.
for(const p of ['python3','python','python3.12','python2'])add([`${p} -c @`,`${p} -c@`,`${p} -uc @`,`${p} -u -c @`,`${p} -Bc @`,`${p} -W ignore -c @`,`${p} -Wignore -c @`,`${p} -X dev -c @`,`${p} -I -c @`,`${p} -BEsc @`,`${p} -Z -c @`,`${p} -OO -c @`,`${p} -q -u -B -c @`,`${p} -c @ arg1 arg2`,`${p} -X utf8 -Wd -c @`,`/usr/bin/${p} -c @`,`env ${p} -c @`,`sudo ${p} -c @`,`echo @ | ${p}`,`echo @ | ${p} -`,`${p} <<< @`,`${p} -u - <<< @`],py);
add(['python3 -m http.server -c @','python3 app.py -c @','python3 -h -c @','python3 --version','python3 -V','python3 --help -c @','python3 -c "print(1)" @','python3 -m pip install @'],py,true);
add(['perl -e @','perl -we @','perl -le @','perl -E @','perl -Mstrict -e @','perl -w -e @','perl -MFile::Path -e @','perl -e@','perl -wle @','perl -0777 -e @','perl -l -0 -e @','perl -I lib -e @','perl -Ilib -e @','perl -nle @','perl -Mstrict -Mwarnings -e @','perl -w -Z -e @','perl -e "1;" -e @','perl -s -e @','perl -T -e @','perl -CS -e @'],pl);
add(['perl -v','perl -h -e @','perl script.pl -e @','perl -V'],pl,true);
add(['ruby -e @','ruby -we @','ruby -rfileutils -e @','ruby -r fileutils -e @','ruby -e@','ruby -W0 -e @','ruby -w -rfileutils -e @','ruby -I lib -e @','ruby -Ilib -rfileutils -e @','ruby --disable=gems -e @','ruby -e "1" -e @','ruby --frob -e @'],rb);
add(['ruby --version','ruby -v script.rb @','ruby script.rb -e @','ruby --help'],rb,true);
for(const n of ['node','nodejs','bun'])add([`${n} -e @`,`${n} --eval @`,`${n} --eval=@`,`${n} -p @`,`${n} -pe @`,`${n} --print @`,`${n} -r fs -e @`,`${n} --no-warnings -e @`,`${n} --require fs --eval @`,`${n} -e @ arg`,`${n} --input-type=module -e @`,`${n} --max-old-space-size=512 -e @`],js);
add(['node app.js -e @','node --version','node -v','node --help','node --check app.js @','node -c app.js','node app.js @'],js,true);
add(['php -r @','php -n -r @','php -d display_errors=0 -r @','php -r@'],php);
add(['php -v','php --version','php script.php -r @','php -f script.php @'],php,true);
// Windows hosts.
const cmdBad='rd /s /q C:\\Users',cmdOk='rd /s /q build',pwBad='Remove-Item -r -fo C:\\Users',pwOk='Remove-Item -r -fo .\\build';
for(const [e,body] of [['C',cmdBad],['R',cmdOk]] as const){
 for(const t of ['cmd /c #','cmd /c "#"','cmd /c"#"','cmd /C #','cmd /k #','cmd /q /c #','cmd /d /s /c "#"','cmd.exe /c #','cmd /v:on /c #','cmd /e:on /f:off /c #','cmd /a /c #','cmd /c#','cmd /K"#"','cmd /d/c #','cmd /c cmd /c #','cmd /c cmd /k "#"','cmd /t:0a /c #'])rows.push(row(e,t.replace('#',body),'cmd','win32'));
 for(const t of ['cmd /c #','cmd /c "#"','cmd.exe /c "#"','cmd /c"#"','cmd /d /c "#"',"Start-Process cmd -ArgumentList '/c #'","Start-Process -FilePath cmd -ArgumentList '/c','#'","saps cmd '/c #'","start cmd '/c #'","Start-Process cmd -Arg '/c #'","Start-Process -Wait -NoNewWindow cmd '/c #'","Start-Process -FilePath cmd.exe -ArgumentList '/c #' -Wait","Start-Process cmd -WorkingDirectory C:\\ -ArgumentList '/c #'","Start-Process -Verb RunAs cmd -ArgumentList '/c #'","& cmd /c #"])rows.push(row(e,t.replace('#',body),'pwsh','win32'));
}
for(const [e,body] of [['C',pwBad],['R',pwOk]] as const){
 for(const t of ['powershell -Command "#"','powershell -c "#"','powershell "#"','powershell -NoProfile "#"','powershell -nop -ep Bypass -c "#"','pwsh -c "#"','pwsh -Command "#"','pwsh -comm "#"','powershell -Command #','powershell #','pwsh -NoLogo -NoProfile -Command "#"','powershell.exe -ExecutionPolicy Bypass -Command "#"','powershell -WindowStyle Hidden -c "#"','pwsh -wd C:\\work -c "#"','powershell -Command "& {#}"','iex "#"','Invoke-Expression "#"','Invoke-Expression -Command "#"','iex -comm "#"',"iex '#'","Start-Process powershell -ArgumentList '-Command #'","Start-Process pwsh -ArgumentList '-NoProfile','-Command','#'","saps powershell '-c #'",'powershell -Command { # }','pwsh -Command { # }'])rows.push(row(e,t.replace('#',body),'pwsh','win32'));
 for(const t of ['powershell -Command "#"','powershell -c "#"','powershell "#"','powershell -NoProfile -Command #','pwsh -c "#"','powershell.exe -nop -c "#"','cmd /c powershell -c "#"','powershell #'])rows.push(row(e,t.replace('#',body),'cmd','win32'));
 for(const t of ['pwsh "#"','pwsh -File "#"','powershell -File "#"','pwsh -nop -File x.ps1 "#"','powershell -? "#"','pwsh -Help'])rows.push(row('R',t.replace('#',body),'pwsh','win32'));
}
it('class 1: host, wrapper and interpreter spellings',()=>{expect(rows.length).toBeGreaterThan(1000);expect(runMatrix('class1',rows)).toEqual([]);});
