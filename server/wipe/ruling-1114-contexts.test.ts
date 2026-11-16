// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN RULING 1114-WIPE-FIXTURE-DIRECTION item 4 (a), (b), (d): rows whose context the reference corpus cannot
// express. Row: expect|dialect|platform|flags|command. dialect none = the caller names no dialect.
// Flags: m = paths named sean/deploy/nosuch do not exist on this host, n = no cwd and no project, p = no platform.
// Commands are data only. No shell, filesystem mutation, or host probes run here.
import {expect,it} from 'vitest';
import {wipeBreaker} from '../wipe-breaker.ts';
import {corpusContext,fixturePathPort} from './corpus/v3-context.fixture.ts';
const gone=(p:string)=>/sean|deploy|nosuch/i.test(p);
const missingPort={...fixturePathPort,realpath:(p:string)=>gone(p)?null:p,lstat:(p:string)=>gone(p)?null:fixturePathPort.lstat!(p),stat:(p:string)=>gone(p)?null:fixturePathPort.stat!(p)};
const rows:string[]=[
 "C|none|linux|@p|rd -r -fo ~",
 "C|none|linux|@p|rmdir -r ~",
 "C|none|linux|@p|rmdir -Recurse -Force ~",
 "C|none|linux|@p|del -Recurse -Force ~",
 "C|none|linux|@p|erase -rec ~",
 "C|none|linux|@p|$x = Remove-Item -Recurse ~",
 "C|none|linux|@p|& Remove-Item -Recurse -Force C:\\",
 "C|none|linux|@p|Set-Location C:\\; Remove-Item -Recurse *",
 "C|none|linux|@p|cmd /c \"rd /s /q C:\\\"",
 "C|none|linux|@p|cmd /c \"echo hi & rd /s /q C:\\\"",
 "C|none|linux|@p|pwsh -Command \"rm -r -fo C:\\\"",
 "C|none|win32||rd /s /q C:\\Users",
 "C|none|win32||echo cleaning & rd /s /q %USERPROFILE%",
 "C|none|win32||rm -r -fo $env:USERPROFILE",
 "R|none|linux|@p|rmdir build",
 "R|none|linux|@p|rm -r -f build",
 "R|none|linux|@p|cmd /c \"rd /s /q build\"",
 "R|none|linux|@p|Remove-Item -Recurse -Force .\\dist",
 "R|none|linux|@p|del -Recurse -Force .\\out",
 "R|none|linux|@p|rd -r -fo node_modules",
 "R|none|linux|@p|D=/work/project/pkg/out; rm -rf \"$D\"",
 "R|none|linux|@p|echo \"C:\\Users\\u\" && ls -Force",
 "R|none|linux|@p|git log --format=%H%n%s -n 5",
 "R|none|linux|@p|for f in *.log; do rm -f \"$f\"; done",
 "R|none|win32||rd /s /q build",
 "R|none|win32||if exist dist rd /s /q dist",
 "C|sh|linux|@m|rm -rf /home/sean/",
 "C|sh|darwin|@m|rm -rf /Users/alex",
 "C|sh|linux|@m|rm -rf /Users/alex",
 "C|sh|linux|@m|rm -rf ~sean",
 "C|sh|linux|@m|sudo rm -rf ~deploy/*",
 "C|pwsh|win32|@m|Remove-Item -Recurse -Force \"C:\\Users\\sean\"",
 "C|none|linux|@mp|Remove-Item -Recurse -Force \"C:\\Users\\sean\"",
 "C|cmd|win32|@m|rd /s /q C:\\Users\\sean",
 "R|sh|linux|@m|rm -rf /Home/sean",
 "R|sh|linux|@m|rm -rf /users",
 "R|sh|linux|@m|rm -rf /home/sean/project/build",
 "R|sh|linux|@m|rm -rf /home/sean/.cache/x",
 "R|sh|linux|@m|rm -rf /tmp/nosuch",
 "R|sh|linux|@m|rm -rf ~sean/project/build",
 "C|sh|linux|@n|find . -name x -execdir rm -rf / \\;",
 "C|sh|linux|@n|find . -ok bash -c \"rm -rf /usr\" {} +",
 "C|sh|linux|@n|A=-exec; find . \"$A\" sh -c 'rm -rf /usr' \\;",
 "C|sh|linux|@n|D=/tmp; if true; then D=/; fi; cd $D && rm -rf *",
 "C|sh|linux|@n|find . -exec rm -rf /home \\;",
 "C|sh|linux|@n|find . -maxdepth 1 -exec rm -rf ~ \\;",
 "R|sh|linux|@n|find . -name '*.o' -exec rm -rf {} \\;",
 "R|sh|linux|@n|find . -type d -name node_modules -exec rm -rf {} +",
 "R|sh|linux|@n|find . -exec rm -rf /tmp/x \\;",
 "C|sh|linux|@n|D=/tmp; if true; then D=/; fi; cd $D && rm -rf *",
 "R|none|linux|@p|rm -rf %USERPROFILE%",
 "R|none|linux|@p|rmdir /s /q ~",
 "R|none|linux|@p|rd /s $HOME",
 "C|none|linux|@p|Remove-Item -Recurse -Force ~",
 "C|none|linux|@p|echo start; Remove-Item -Recurse -Force $HOME",
 "C|none|linux|@p|bash -c 'rm -rf ~'"
];
it.each(rows)('%s',line=>{
 const [expected,dialect,platform,flagText,...rest]=line.split('|'),cmd=rest.join('|'),flags=flagText!.startsWith('@')?flagText!.slice(1):'';
 const cwd=platform==='win32'?(dialect==='sh'?'/c/work/project/pkg':'C:\\work\\project\\pkg'):'/work/project/pkg';
 const ctx:Record<string,unknown>={...corpusContext({platform:platform as never,dialect:(dialect==='none'?'sh':dialect) as never,cwd})};
 if(dialect==='none')delete ctx.dialect;
 if(flags.includes('m'))ctx.pathPort=missingPort;
 if(flags.includes('n')){delete ctx.cwd;delete ctx.project;}
 if(flags.includes('p'))delete ctx.platform;
 const hit=wipeBreaker(cmd,ctx as never);
 if(expected==='C'){expect(hit,cmd).not.toBeNull();expect(hit?.rule,cmd).not.toBe('wipe-check-fault');}
 else expect(hit,cmd).toBeNull();
});
