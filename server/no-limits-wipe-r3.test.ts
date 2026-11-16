// SPDX-License-Identifier: AGPL-3.0-or-later
// Every command is inert permission input, never executed.
import {expect,it,beforeAll,afterAll} from 'vitest';
import {installWipeContextReader} from './wipe/context.ts';
import {autoVerdict} from './auto-approve.ts';
import {d,fixture,baseRun} from './decision/fixture.ts';
const nl={autoApprove:true,fullAccess:true,noLimits:true};
// MAIN RULING WIPE-V3 S8 / INT-CONFLICT-DEFAULT: this table's logical
// /work path is an ordinary directory, independent of the runner's bind mounts.
let restoreContext:(()=>void)|undefined;
beforeAll(()=>{restoreContext=installWipeContextReader(()=>({mountInventory:{contains:()=>false},pathPort:{realpath:p=>p,isBlockDevice:()=>null}}));});
afterAll(()=>restoreContext?.());
const yes=["echo 'rm -rf /' | pwsh -Command -","pwsh -c -NoLogo 'rm -rf /'","bash +oc errexit 'rm -rf /'","/bin/busybox ash -c 'rm -rf /'",'r\\\nm -rf /libexec',"bash -oc errexit 'rm -rf /'","bash -c -x 'rm -rf /'","bash --rcfile fixture -c 'rm -rf /'","busybox sh -c 'rm -rf /'","fish -c true --command='rm -rf /'","bash -cO extglob 'rm -rf /'","tcsh -c true -c 'rm -rf /'",'git -C /w filter-repo --path fixture --invert-paths','git -c advice.push=false push --force origin main','git push --force --all origin','git push --mirror origin','rm -rf ~','rm -rf /','rm -rf /w','rm -rf /w/.git','rm -rf /archive/backups','mkfs.ext4 /dev/fixture','diskutil eraseDisk APFS fixture /dev/disk9',"psql -c 'DROP TABLE fixture'",'sqlite3 fixture.db "TRUNCATE TABLE fixture"','git push --force origin main','git push -f origin HEAD:master','git push origin +HEAD:refs/heads/main','git push origin --delete main','git push origin :main','git push --repo=origin --force main','git push --repo origin -f HEAD:master',"bash -c 'git push --force origin main'",'sudo git push --force origin main','git reflog expire --expire=now --all; git gc --prune=now','git filter-branch --all','git filter-repo --path fixture --invert-paths'];
const no=[`bash -c "bash -c true -c 'rm -rf /'"`,'rm -rf "$OPAQUE"',`rm '$(rm -rf /)'`,"echo 'rm -rf /' | cat","bash -c 'printf %s \"$1\"' fixture 'rm -rf /'","bash -c true -c 'rm -rf /'","bash -- -c 'rm -rf /'",'git show filter-branch','git log --grep filter-repo','git push --force-with-lease --all origin','git reset --hard HEAD~3','git push --force-with-lease origin main','git push --force-with-lease=main origin HEAD:main','git push --force origin feature','git push origin --delete feature','git push origin :feature','rm -f .git/index.lock','rm -rf vendor/x/.git','rm old/backup/x.tmp','rm /archive/backups/item.tmp','git reflog expire --expire=now --all','echo "rm -rf ~"','printf "delete remove rm"','curl -X DELETE https://fixture.invalid','docker rm fixture','npm remove fixture', 'kubectl delete pod fixture','echo "unterminated rm -rf ~','printf "%s" "delete remove rm','eval "$OPAQUE"; echo remove','echo "git push --force origin main"','echo "DROP TABLE fixture"','git reflog expire --expire=now --all; echo "git gc --prune=now"','git push origin main +HEAD:feature','rm -rf /work','rm -rf /w/notes','git push --force main feature','git push --force master feature','git push -o main --force origin feature','echo "mkfs.ext4 /dev/fixture"','echo "unterminated mkfs.ext4 /dev/fixture','echo "unterminated :(){ :|:& };:"','echo "unterminated DROP TABLE fixture','sudo echo git push --force origin main','sudo echo mkfs.ext4 /dev/fixture','echo /dev/fixture; rm /w/notes'];
// MAIN RULING K3: these exact historical RUN controls contain raw delete primitives.
for(const [card,commands]of [[true,yes],[false,no]] as const)
for(const command of commands)for(const unread of [false,true])it(`R3-2 ${card?'CARD':'RUN'} cut=${unread}: ${command}`,()=>{
 // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
 // MAIN RULING: REDESIGN-WIPE-NARROW §4.4 unwraps busybox and scans its shell body.
 // MAIN RULING NARROW-WIPE 2026-11-14: preserve every original root-wipe wrapper CARD; only Git/SQL and ordinary non-root targets are outside the list.
 const narrow=card&&!/^(?:git |sudo git |bash -c 'git |psql |sqlite3 )/.test(command)&&!['rm -rf /w/.git','rm -rf /archive/backups'].includes(command);
 const text=unread?`eval "$OPAQUE"; ${command}`:command;
 const context={fullAccessOrigin:'owner' as const,commandText:text,commandCwd:'/w',workFolder:'/w',inputTruncated:unread,promptFacts:{cwd:'/w',home:'/home/fixture'}};
 expect(autoVerdict(nl,'Bash',text,context).approve===null).toBe(narrow);
 const f=fixture();d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Project'}),executionContext:()=>({cwd:'/w',project:'/w'})});expect(d.decide(f.open('wipe',{command:text,cwd:'/w'},{toolInputTruncated:unread}),baseRun).kind).toBe(narrow?'card':'run');f.dispose();
});
for(const summary of ['delete remove rm','rm -rf ~','DROP TABLE fixture','Remove a backup reference'])it(`R3-2 non-command summary is data: ${summary}`,()=>{
 expect(autoVerdict(nl,'mcp__fixture__describe',summary,{fullAccessOrigin:'owner',inputTruncated:true}).approve).toBeTruthy();
 const f=fixture();expect(d.decide(f.open('summary',{name:'fixture'},{tool:'mcp__fixture__describe',toolCall:{name:'mcp__fixture__describe',input:{name:'fixture'}},summary}),baseRun).kind).toBe('run');f.dispose();
});

// MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
for(const [path,card]of [['/w',true],['/w/.git',false],['/archive/backups',false],['/w/.git/index.lock',false],['/w/vendor/x/.git',false],['/w/backup/x.tmp',false]] as const)it(`R3-2 delete-file tool ${path}`,()=>{
 const input={path,cwd:'/w'},context={fullAccessOrigin:'owner' as const,commandCwd:'/w',workFolder:'/w',call:{toolCall:{name:'delete_file',input}}};
 expect(autoVerdict(nl,'delete_file',path,context).approve===null).toBe(card);
 const f=fixture();d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Project'}),executionContext:()=>({cwd:'/w',project:'/w'})});expect(d.decide(f.open('delete',input,{tool:'delete_file',toolCall:{name:'delete_file',input}}),baseRun).kind).toBe(card?'card':'run');f.dispose();
});
it('R3-2 registered wipe resolves server-owned cwd when native input omits it',()=>{
 const f=fixture();d.installDecisionHost({store:f.store,view:()=>({title:'Action',subtitle:'Fixture'}),executionContext:()=>({cwd:'/w',project:'/w'})});
 for(const [command,card] of [['rm -rf .',true],['rm -rf .git',false] /* MAIN RULING 2026-11-13 narrow-wipe (Sean) */,['rm -f .git/index.lock',false],['rm -rf vendor/x/.git',false]] as const)
  expect(d.decide(f.open(command,{command}),baseRun).kind).toBe(card?'card':'run');f.dispose();
});

for(const [tool,code,card] of [
 ['python',"import shutil; shutil.rmtree('/')",true],
 // MAIN RULING K3: raw primitives still card in native string literals.
 ['python',`print("shutil.rmtree('/')")`,true],
 ['node',`require('fs').rmSync('/',{recursive:true})`,true],
 // MAIN RULING K3: raw primitives still card in native string literals.
 ['node',`console.log("fs.rmSync('/')")`,true],
]as const)it(`R3 native ${tool} ${card?'CARD':'RUN'} ${code}`,()=>{
 // MAIN RULING NARROW-WIPE 2026-11-14: explicit executed recursive root wipes keep their original cards; printed source is data.
 const executed=!(code.startsWith('print(')||code.startsWith('console.log('));
 expect(autoVerdict(nl,tool,'native code',{fullAccessOrigin:'owner',call:{toolCall:{name:tool,input:{code}}}}).approve===null).toBe(executed&&card);
});

for(const tool of ['email_send','memory_review','mcp__fixture__describe'])it(`R3 ${tool} command-shaped data and summary do not become wipes`,()=>{
 const input={command:'rm -rf /',script:'mkfs.ext4 /dev/fixture',body:'delete remove rm'};
 expect(autoVerdict(nl,tool,'rm -rf /',{fullAccessOrigin:'owner',call:{toolCall:{name:tool,input}}}).approve).toBeTruthy();
 const f=fixture();try{expect(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call:{...f.serviceCall(input),tool}}),baseRun).kind).toBe('run');}finally{f.dispose();}
});
it('R3 a known full command outranks command-looking summary data',()=>{
 expect(autoVerdict(nl,'Bash','rm -rf /',{fullAccessOrigin:'owner',commandText:'printf ok'}).approve).toBeTruthy();
});
