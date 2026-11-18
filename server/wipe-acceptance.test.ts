// SPDX-License-Identifier: AGPL-3.0-or-later
// Only this adapter surface is imported, unchanged on every pinned commit.
import {it,expect,captureWipeInput,releaseContextProbe,productionCounters,shell,native,effects,decideFixture,releaseFixture,recovery,registerRoots,realpathCounter,defaultContext as ctx,windowsContext as win} from './wipe-acceptance-adapter.ts';
// MAIN RULING WIPE-GATE-BAR / WIPE-V3 S2,S4: T14 and W15 execute resolved root deletes.
const rows: [string,string,boolean,(string|null)?][] = [
 [
  "T1",
  "rm -rf /",
  true,
  "delete-root"
 ],
 [
  "T2",
  "rm -fr ~",
  true,
  "delete-home"
 ],
 [
  "T3",
  "rm -r -f -- /home",
  true,
  "delete-home"
 ],
 [
  "T4",
  "rm --recursive --force /Users",
  true,
  "delete-home"
 ],
 [
  "T5",
  "rm -rf ./build",
  false,
  null
 ],
 [
  "T6",
  "rm -rf /work/project/node_modules",
  false,
  null
 ],
 [
  "T7",
  "rm -rf /work/project",
  true,
  null
 ],
 [
  "T8",
  "rm -rf /work/project/",
  true,
  null
 ],
 [
  "T9",
  "rm -rf /work/project/*",
  true,
  null
 ],
 [
  "T10",
  "rm -rf /work/project/*.log",
  false,
  null
 ],
 [
  "T11",
  "rm -rf \"$UNSET/\"",
  true,
  "delete-root"
 ],
 [
  "T12",
  "rm -rf \"${UNSET:?}/\"",
  false,
  null
 ],
 [
  "T13",
  "rm -rf '$HOME'",
  false,
  null
 ],
 [
  "T14",
  "rm -rf $(echo /)",
  true,
  null
 ],
 [
  "T15",
  "echo \"rm -rf /\"",
  false,
  null
 ],
 [
  "T16",
  "rm /",
  false,
  null
 ],
 [
  "T17",
  "rm -rf /etc",
  true,
  "delete-system-folder"
 ],
 [
  "T18",
  "rm -f /etc/passwd",
  false,
  null
 ],
 [
  "T19",
  "rm -rf /etc/nginx",
  false,
  null
 ],
 [
  "T20",
  "cd / && rm -rf *",
  true,
  "delete-root"
 ],
 [
  "T21",
  "cd ~ && rm -rf .",
  true,
  "delete-home"
 ],
 [
  "T22",
  "cd /work/project && rm -rf ..",
  true,
  null
 ],
 [
  "T23",
  "rm -rf ~/.murage",
  true,
  "delete-system-folder"
 ],
 [
  "T24",
  "rm -rf /Volumes/Backup",
  true,
  "delete-root"
 ],
 [
  "T25",
  "rm -rf /mnt/data/old",
  false,
  null
 ],
 [
  "T26",
  "rm -rf /work",
  true,
  null
 ],
 [
  "T27",
  "rm -rf /home/u/.murage/workspaces/b1/threads/t9",
  true,
  null
 ],
 [
  "T28",
  "rm -rf /home/u/.murage/workspaces/b1/threads/t9/out",
  false,
  null
 ],
 [
  "T29",
  "rm -rf /work/project | tee log",
  true,
  null
 ],
 [
  "T30",
  "if true; then rm -rf ~; fi",
  true,
  null
 ],
 [
  "T31",
  "rm -rf \"/work/pro\"'ject'",
  true,
  null
 ],
 [
  "T32",
  "rm -rf $'/work/project'",
  true,
  null
 ],
 [
  "T33",
  "rm -rf / \"",
  true,
  null
 ],
 [
  "T34",
  "cd \"$(mktemp -d)\" && rm -rf .",
  false,
  null
 ],
 [
  "W1",
  "sudo rm -rf /",
  true,
  null
 ],
 [
  "W2",
  "sudo -u root -- rm -rf /",
  true,
  null
 ],
 [
  "W3",
  "sudo -uroot rm -rf /",
  true,
  null
 ],
 [
  "W4",
  "sudo --user=root rm -rf /",
  true,
  null
 ],
 [
  "W5",
  "env FOO=1 rm -rf ~",
  true,
  null
 ],
 [
  "W6",
  "env -S 'rm -rf /'",
  true,
  null
 ],
 [
  "W7",
  "nice -n 10 rm -rf ~",
  true,
  null
 ],
 [
  "W8",
  "nice -10 rm -rf ~",
  true,
  null
 ],
 [
  "W9",
  "timeout -s KILL 5 rm -rf ~",
  true,
  null
 ],
 [
  "W10",
  "ionice -c3 rm -rf ~",
  true,
  null
 ],
 [
  "W11",
  "nohup rm -rf ~ &",
  true,
  null
 ],
 [
  "W12",
  "busybox rm -rf /",
  true,
  null
 ],
 [
  "W13",
  "command rm -rf /",
  true,
  null
 ],
 [
  "W14",
  "exec rm -rf /",
  true,
  null
 ],
 [
  "W15",
  "echo / | xargs rm -rf",
  true,
  null
 ],
 [
  "W16",
  "xargs -0 rm -rf /",
  true,
  null
 ],
 [
  "W17",
  "find / -delete",
  true,
  null
 ],
 [
  "W18",
  "find ~ -mindepth 1 -type f -delete",
  true,
  "delete-home"
 ],
 [
  "W19",
  "find . -name '*.o' -delete",
  false,
  null
 ],
 [
  "W20",
  "find /work/project -exec rm -rf {} +",
  true,
  null
 ],
 [
  "W21",
  "find . -name node_modules -exec rm -rf {} +",
  false,
  null
 ],
 [
  "W22",
  "stdbuf -o0 rm -rf ~",
  true,
  null
 ],
 [
  "W23",
  "flock /tmp/l rm -rf ~",
  true,
  null
 ],
 [
  "N1",
  "bash -c 'rm -rf ~'",
  true,
  null
 ],
 [
  "N2",
  "sh -lc \"rm -rf /\"",
  true,
  null
 ],
 [
  "N3",
  "su -c 'rm -rf /'",
  true,
  null
 ],
 [
  "N4",
  "eval \"rm -rf /\"",
  true,
  null
 ],
 [
  "N5",
  "ssh host 'rm -rf /'",
  false,
  null
 ],
 [
  "N6",
  "docker run img rm -rf /",
  false,
  null
 ],
 [
  "N7",
  "echo $(rm -rf /work/project)",
  true,
  null
 ],
 [
  "N10",
  "bash <<< 'rm -rf ~'",
  true,
  null
 ],
 [
  "M1",
  "mv /work/project /tmp/old",
  true,
  null
 ],
 [
  "M2",
  "mv -t /tmp /work/project",
  true,
  null
 ],
 [
  "M3",
  "mv -ft /tmp /work/project",
  true,
  null
 ],
 [
  "M4",
  "mv -vt/tmp /work/project",
  true,
  null
 ],
 [
  "M5",
  "mv --target-directory=/tmp /work/project",
  true,
  null
 ],
 [
  "M6",
  "mv --target /tmp /work/project",
  true,
  null
 ],
 [
  "M7",
  "mv -T /work/project /tmp/x",
  true,
  null
 ],
 [
  "M8",
  "mv ./a /work/project",
  false,
  null
 ],
 [
  "M9",
  "mv ~ /tmp/h",
  true,
  "delete-home"
 ],
 [
  "M10",
  "mv /etc /etc.bak",
  true,
  "delete-system-folder"
 ],
 [
  "M11",
  "mv -S .bak /work/project /tmp",
  true,
  null
 ],
 [
  "M12",
  "mv -- -t /work/project",
  false,
  null
 ],
 [
  "M13",
  "mv -Q /work/project /tmp",
  true,
  null
 ],
 [
  "M14",
  "mv -Q ./a ./b",
  false,
  null
 ],
 [
  "Y1",
  "rsync -a --delete ./empty/ ~/",
  true,
  null
 ],
 [
  "Y2",
  "rsync -av --delete src/ /work/project/dist/",
  false,
  null
 ],
 [
  "Y3",
  "rsync -a --delete-after -e ssh ./e/ ~/",
  true,
  null
 ],
 [
  "Y4",
  "rsync -aessh --delete ./e/ ~/",
  true,
  null
 ],
 [
  "Y5",
  "rsync -a --delete ./e/ host:/home/u",
  false,
  null
 ],
 [
  "Y6",
  "rsync -a --remove-source-files ~/ /backup/",
  true,
  null
 ],
 [
  "Y7",
  "rsync -a ~/ /backup/",
  false,
  null
 ],
 [
  "Y8",
  "rsync -a --del --exclude .git ./e/ /work/project",
  true,
  null
 ],
 [
  "P1",
  "Remove-Item -Recurse -Force C:\\Users",
  true,
  "delete-home"
 ],
 [
  "P2",
  "Remove-Item C:\\Users\\u -Recurse",
  true,
  "delete-home"
 ],
 [
  "P3",
  "ri -r -fo $env:USERPROFILE",
  true,
  "delete-home"
 ],
 [
  "P4",
  "Remove-Item -Path C:\\ -Recurse",
  true,
  "delete-root"
 ],
 [
  "P5",
  "Remove-Item -LiteralPath 'C:\\Windows' -Recurse:$true",
  true,
  "delete-system-folder"
 ],
 [
  "P6",
  "Remove-Item .\\build -Recurse",
  false,
  null
 ],
 [
  "P7",
  "Get-ChildItem C:\\Users\\u | Remove-Item -Recurse -Force",
  true,
  "delete-home"
 ],
 [
  "P8",
  "Move-Item -Path C:\\Users\\u -Destination D:\\x",
  true,
  null
 ],
 [
  "P9",
  "Format-Volume -DriveLetter D",
  true,
  null
 ],
 [
  "P10",
  "Clear-Disk -Number 1 -RemoveData",
  true,
  null
 ],
 [
  "P11",
  "Remove-Item -Recurse C:\\Users\\u\\proj\\tmp",
  false,
  null
 ],
 [
  "P12",
  "powershell -Command \"Remove-Item -Recurse C:\\Users\"",
  true,
  null
 ],
 [
  "P13",
  "pwsh -c 'rm -r -fo ~'",
  true,
  null
 ],
 [
  "P15",
  "Remove-Item -Recurse:$false C:\\Users\\u",
  false,
  null
 ],
 [
  "C1",
  "rd /s /q C:\\",
  true,
  "delete-root"
 ],
 [
  "C2",
  "rmdir /s /q %USERPROFILE%",
  true,
  "delete-home"
 ],
 [
  "C3",
  "del /s /q C:\\Users\\u\\*",
  true,
  "delete-home"
 ],
 [
  "C4",
  "del /q file.txt",
  false,
  null
 ],
 [
  "C5",
  "cmd /c \"rd /s /q C:\\Users\"",
  true,
  null
 ],
 [
  "C6",
  "robocopy C:\\empty C:\\Users\\u /MIR",
  true,
  null
 ],
 [
  "C7",
  "robocopy src C:\\Users\\u\\proj\\out /MIR",
  false,
  null
 ],
 [
  "C8",
  "format D:",
  true,
  null
 ],
 [
  "C9",
  "move C:\\Users\\u D:\\",
  true,
  null
 ],
 [
  "D1",
  "mkfs.ext4 /dev/sdb1",
  true,
  null
 ],
 [
  "D2",
  "sudo wipefs -a /dev/sda",
  true,
  null
 ],
 [
  "D3",
  "dd if=/dev/zero of=/dev/sda bs=1M",
  true,
  null
 ],
 [
  "D4",
  "dd if=/dev/zero of=./zero.img",
  false,
  null
 ],
 [
  "D5",
  "cat img > /dev/disk2",
  true,
  null
 ],
 [
  "D6",
  "diskutil eraseDisk APFS X disk2",
  true,
  null
 ],
 [
  "D7",
  "diskutil list",
  false,
  null
 ],
 [
  "D8",
  "diskpart /s script.txt",
  true,
  null
 ],
 [
  "D9",
  "echo x > /dev/null",
  false,
  null
 ],
 [
  "D10",
  "sudo dd if=x of=/dev/nvme0n1",
  true,
  null
 ],
 [
  "D11",
  "shred -n1 /dev/sda",
  true,
  null
 ],
 [
  "D12",
  "shred secret.txt",
  false,
  null
 ],
 [
  "N8",
  "bash <<EOF\nrm -rf /\nEOF",
  true,
  null
 ],
 [
  "N9",
  "cat <<EOF > x.sh\nrm -rf /\nEOF",
  false,
  null
 ]
];
for(const [id,input,card,rule] of rows)it(id,()=>{const hit=shell(input,id.startsWith('P')?{...win,dialect:'pwsh'}:id.startsWith('C')?{...win,dialect:'cmd'}:ctx);expect(!!hit).toBe(card);if(rule)expect(hit?.rule).toBe(rule);if(id==='M3')expect(shell('mv -ft /work/project ./file',ctx)).toBeNull();if(id==='M13')expect(shell('mv -Q /work/project',ctx)).toBeTruthy();if(id==='T18')expect(shell('rm -f /etc',ctx)).toBeNull();if(id==='P3')expect(shell('ri -Rec:$false C:\\Users\\u',{...win,dialect:'pwsh'})).toBeNull();if(id==='Y3')expect(shell('rsync -a --delete ./e/ /tmp/cache -e /home/u',ctx)).toBeNull();if(id==='M7')expect(shell('mv -T /work/project',ctx)).toBeTruthy();if(id==='M14')expect(shell('rm -Q /etc',ctx)).toBeNull();});
it('P14',()=>expect(shell('pwsh -EncodedCommand '+Buffer.from('Remove-Item -Recurse C:\\','utf16le').toString('base64'),win)).toBeTruthy());
it('N11',()=>{let s='rm -rf /';for(let i=0;i<9;i++)s='bash -c '+"'"+s.replaceAll("'","'\\''")+"'";// MAIN RULING 23:15Z(d), v2 DELTA2: nesting is not an approval policy.
expect(shell(s,ctx)?.rule).toBe('delete-root');});
const regressions:[string,string,boolean][]=[
 ['R1-H1a','env -u HOME rm -rf "$HOME"',true],['R1-H1b','HOME=/tmp rm -rf "$HOME"',true],['R1-H1c','HOME=/tmp; rm -rf "$HOME"',false],['R1-H1d',"HOME=/tmp bash -c 'rm -rf \"$HOME\"'",false],
 ['R1-H3a','mv -t /tmp /work/project',true],['R1-H3b','rsync -a --delete ./empty/ "$HOME/" >sync.log',true],
 ['R2-H1a','mv -ft /tmp /work/project',true],['R2-H1b','>wipe.log rm -rf "$HOME"',true],['R2-H1c','2>/dev/null rm -rf /',true],['R2-H1d','<in.txt >out.log 2>&1 rm -rf ~',true]
];
for(const [id,input,card]of regressions)it(id,()=>expect(!!shell(input,ctx)).toBe(card));
it('R1-H2a',()=>{const input={command:'rm -rf /',pad:'x'.repeat(17<<20)};expect(decideFixture('Bash',input,{context:ctx}).kind).toBe('card');expect(captureWipeInput(input)?.command).toBe(input.command);});
it('R1-H2b',()=>expect(decideFixture('Bash',{command:'rm -rf /',pad:'x'.repeat(17<<20)},{context:ctx,event:{toolInputTruncated:true}}).kind).toBe('card'));
it('R1-H4',()=>{const counts=[10,10000].map(n=>{registerRoots(Array.from({length:n},(_,i)=>'/work/root-'+i));realpathCounter();shell('rm -rf /tmp/x',ctx);return realpathCounter();});expect(counts[0]).toBe(counts[1]);expect(counts[1]).toBeLessThanOrEqual(2);});
it('R1-H5',async()=>{registerRoots(['/work/project','/work/other']);expect(await recovery({command:'rm -rf /work/other'},ctx)).toBe('deny');});
const nativeRows:[string,string,unknown,boolean][]=[
 ['R2-H2a','delete_files',{filePath:'/etc',recursive:true},true],['R2-H2b','delete_directory',{path:'/usr'},true],['R2-H2c','move_file',{source:'/work/project',destination:'/tmp/x'},true],['R2-H2d','write_file',{path:'/etc/hosts',content:'x'},false],
 ['X1','delete_file',{path:'/work/project/a.txt'},false],['X2','delete_directory',{path:'/work/project'},true],['X3','delete_files',{filePath:'/etc',recursive:true},true],['X4','delete_files',{filePath:'/etc',recursive:false},false],['X5','delete',{path:'~'},true],['X6','move_file',{source:'~',destination:'/tmp/h'},true],['X7','write_file',{path:'/home/u',content:''},false],['X8','apply_patch',{patch:'*** Delete File: /work/project/x'},false],['X9','write_file',{path:'/dev/sda'},true],['X10','mcp__fs__delete_directory',{path:'/Users'},true]
];
for(const [id,tool,input,card]of nativeRows)it(id,()=>{expect(!!native(tool,input,ctx)).toBe(card);if(id==='X3')expect(effects([{op:'delete',path:'/etc',recursive:true,followFinal:false}],ctx)).toBeTruthy();});
it('R2-H2a-fixture',()=>expect(decideFixture('delete_files',{filePath:'/etc',recursive:true},{context:ctx}).kind).toBe('card'));
it('R2-H2b-effects',()=>expect(effects([{op:'delete',path:'/usr',followFinal:false}],ctx)).toBeTruthy());
it('X11',()=>expect(effects([{op:'rename',source:'/work/other',path:'/tmp/o',followFinal:false}],ctx)).toBeTruthy());
it('X12',async()=>expect((await releaseFixture('Bash',{command:'rm -rf /'},{command:'rm -rf ~'},ctx)).released).toBe(false));
it('X13',async()=>{expect((await releaseFixture('delete_directory',{path:'/tmp/safe'},{path:ctx.dataDir},ctx)).released).toBe(false);expect(releaseContextProbe({...ctx,dataDir:'/data/fixture/state'})).toHaveLength(1);});
it('F1',()=>expect(decideFixture('Bash',{command:'rm -rf /',pad:'x'.repeat(17<<20)},{context:ctx}).kind).toBe('card'));
it('F2',()=>{const hit=shell('rm -rf /',{...ctx,pathPort:{realpath(){throw Error('fixture-fault');},isBlockDevice(){return null;}}});// MAIN RULING 23:15Z(d): a target IO fault keeps lexical root evidence.
expect(hit?.rule).toBe('delete-root');});
// MAIN RULING 23:15Z(d), v2 DELTA2: readable harmless text has no size gate.
it('F3',()=>expect(shell('x'.repeat(65<<20),ctx)).toBeNull());
it('F4',async()=>{const input=new Proxy({},{ownKeys(){throw Error('fixture-integrity');},getOwnPropertyDescriptor(){throw Error('fixture-integrity');}});expect(await recovery(input,ctx)).toBe('deny');});
it('G1',()=>expect(decideFixture('Bash',{command:'rm -rf ./build'},{initiator:{k:'guest'},context:ctx}).kind).toBe('card'));
it('G2',()=>expect(decideFixture('Bash',{command:'echo hi'},{level:'ask',context:ctx}).kind).toBe('card'));
it('G3',()=>{const result=decideFixture('Bash',{command:'rm -rf /'},{featureOff:'The shell is off.',context:ctx});expect(result.kind).toBe('refuse');});
it('G4',()=>expect(decideFixture('Bash',{command:'rm -rf ./build'},{context:ctx}).kind).toBe('run'));
it('G5',()=>expect(decideFixture('Bash',{command:'git push --force origin main'},{context:ctx}).kind).toBe('run'));
it('G6',()=>expect(decideFixture('Bash',{command:'echo hi'},{owner:false,context:ctx}).kind).toBe('card'));

it('R2-H3',async()=>{const small=await productionCounters(50),large=await productionCounters(5000);expect(small).toEqual({reads:0,replaces:0,realpathCalls:0});expect(large).toEqual(small);});

// MAIN RULING 23:15Z(d): optional context failure is not unreadable input.
it('F5-context',()=>expect(decideFixture('Bash',{command:'echo hi'},{executionContext(){throw Error('fixture-context-fault');}}).kind).toBe('run'));
