// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export interface R2Row { id:string; command:string; cwd:string; protect:boolean }
const pairs: Array<[string,string,string?,string?,string?]> = [
 ['C-FAIL','if; cd /definitely-missing; printf x > PATH','hosts','notes','/etc'],
 ['C-OR','if; cd /tmp || true; printf x > PATH','hosts','notes','/etc'],
 ['C-AND','if; cd /etc && printf x > PATH','hosts','./notes'],
 ['C-WRAP','if; env -C /tmp true; printf x > PATH','hosts','notes','/etc'],
 ['C-WRAP-OWN','if; env -C /etc tee PATH','hosts','notes'],
 ['C-SUB','if; (cd /tmp); printf x > PATH','hosts','notes','/etc'],
 ['C-OVF','if; '+Array.from({length:17},(_,i)=>`cd "$d${i}";`).join('')+'printf x > PATH','hosts','notes'],
 ['C-S1','set --; cd /nope; tar -xf /tmp/a.tar','', ''],
 ['CAP-SEG','if; '+'true;'.repeat(5000)+'touch PATH'],
 ['CAP-LEN','set --;'+'true;'.repeat(14000)+'printf x > PATH'],
 ['CAP-DEPTH','if; echo '+'$(echo '.repeat(10)+'$(touch PATH)'+')'.repeat(10)],
 ['CAP-WORD',"if; echo '"+'x'.repeat(300*1024)+"'; touch PATH"],
 ['E-RAW-PREFIX','if; find . -exec touch PATH/"$p" \\;','/etc','./out'],
 ['E-RAW-SUFFIX','if; find . -execdir tee "$p/PATH" \\;','hosts','notes'],
 ['E-RAW-BOUND','p=PATH; if; find . -exec touch "$p" \\;'],
 ['E-FIND','if; find . -maxdepth 0 -exec touch PATH \\;'],
 ['E-FIND+','if; find . -exec tee PATH {} +'],
 ['E-FIND-PLUS-OPERAND','if; find . -maxdepth 0 -exec touch + PATH \\;'],
 ['E-EXECDIR','if; find . -execdir tee PATH \\;','hosts','notes'],
 ['E-OK','if; find . -ok touch PATH \\;'],
 ['E-OKDIR','if; find . -okdir tee PATH \\;','hosts','notes'],
 ['E-TOCMD',"if; tar -xf ./a.tar --to-command='tee PATH'"],
 ['E-CKPT',"if; tar -xf ./a.tar --checkpoint-action=exec='touch PATH'"],
 ['E-PROG',`if; tar -cf ./o.tar -I 'sh -c "touch PATH"' ./x`],
 ['E-RSH',`if; rsync -e 'sh -c "touch PATH"' ./a ./b`],
 ['E-TRAP',"if; trap 'touch PATH' EXIT"],
 ['E-SU',"if; su me -c 'touch PATH'"],
 ['E-S1','set --; find . -exec touch PATH \\;'],
 ['P-a','if; chmod -x PATH'],['P-b','if; chmod -w,+x PATH'],
 ['P-b-empty','if; chmod u-x,go= PATH'],['P-c','if; chmod -R -r PATH','~/.ssh','./d'],
 ['P-d','if; chmod --reference=./r PATH'],['P-e','if; chmod -- -x PATH'],
 ['P-f','if; chown -R me:staff PATH'],['P-chgrp','if; chgrp staff PATH'],
 ['P-g','set --; chmod -x PATH'],['M-SED','if; sed -i s/x/y/ PATH'],
 ['L5-STDIN',"if; bash -s <<'EOF'\ntouch PATH\nEOF"],
 ['L5-QUEUE',"if; cat <<A 3<<'B'\n$(touch PATH)\nA\nx\nB"],
 ['L5-FD0-LAST',"if; bash 3<<'A' <<'B'\ndata\nA\ntouch PATH\nB"],
];
export const r2Rows:R2Row[]=pairs.flatMap(([id,template,protectedPath,ordinaryPath,cwd])=>[true,false].map(protect=>({id:`${id}-${protect?'RED':'RUN'}`,command:(protect?template:template.replace('cd /etc &&','cd /definitely-missing &&').replace('env -C /etc tee','env -C ./o tee')).replaceAll('PATH',protect?protectedPath??'~/.ssh/config':ordinaryPath??'./notes'),cwd:id==='C-S1'?(protect?'/etc':'/work'):cwd&&protect?cwd:'/work',protect})));
r2Rows.push(...[
 ['L5-EVAL',"if; eval <<EOF\ntouch ~/.ssh/config\nEOF"],
 ['L5-C',"if; bash -c cat <<'EOF'\ntouch ~/.ssh/config\nEOF"],
 ['L5-SCRIPT',"if; bash ./a.sh <<'EOF'\ntouch ~/.ssh/config\nEOF"],
 ['L5-FD3',"if; bash 3<<'EOF'\ntouch ~/.ssh/config\nEOF"],
 ['L5-REPLACED',"if; bash <<'EOF' <./input\ntouch ~/.ssh/config\nEOF"],
 ['L5-ESCAPE','if; cat <<EOF\n\\$(touch ~/.ssh/config)\nEOF'],
 ['P-REF-READ','if; chmod --reference=~/.ssh/config ./notes'],
 ['E-FIND-RUN','if; find . -exec ls {} +'],
 // MAIN 2026-11-11 23:30Z: GNU tar manual §6.10.1 says -C is cumulative;
 // this ordinary twin extracts unknown members under /tmp/w.
 ['M-ROOT-ORDINARY','if; tar -xf /tmp/a -C /tmp -C ./w'],
 ['OVERFLOW-UNREACHED','echo ordinary\n'.repeat(20000)],
].map(([id,command])=>({id,command,cwd:'/work',protect:false})));
// MAIN 2026-11-11 23:30Z replaces the r2 Medium RUN row. GNU tar manual
// §6.10.1, https://www.gnu.org/software/tar/manual/html_node/directory.html:
// -C is cumulative: /etc then ./w means /etc/w. Unknown members fail closed.
// Keep the original id/input so its historical Full access bytes stay pinned.
r2Rows.push({id:'M-ROOT-UNUSED',command:'if; tar -xf /tmp/a -C /etc -C ./w',cwd:'/work',protect:true});
// Same MAIN ruling and tar manual: the earlier member m lands in /etc.
r2Rows.push({id:'M-ROOT-USED',command:'if; tar -xf /tmp/a -C /etc m -C ./w',cwd:'/work',protect:true});
// Physical navigation is exercised against an isolated symlink fixture in
// no-limits-r2-cwd.test.ts. Full access never reads that disk state; its twins
// use a stable trusted cwd to preserve exact registration/hash bytes.
export const physicalFullAccessRows:Array<{id:string;command:string;cwd:string;tool?:string}>=[
 'cd -P e && cd .. && printf x > hosts',
 'cd -L e && cd .. && printf x > hosts',
 'cd -P o && cd .. && printf x > hosts',
 'cd -P e && cd -L . && cd .. && printf x > hosts',
 'd=./e; cd -Pe "$d" && cd .. && printf x > hosts',
 'cd -P e && pushd /work && popd && cd .. && printf x > hosts',
 'cd -P e && cd - && cd - && cd .. && printf x > hosts',
 'cd /tmp && printf x > hosts',
 'cd /tmp && true; printf x > hosts',
].map((command,index)=>({id:`H2-PHYSICAL-${index}`,command,cwd:'/work'}));

physicalFullAccessRows.push(
 {id:'H2-PHYSICAL-unknown-prefix',command:'if; cd "$d"; tee "$prefix/hosts"',cwd:'/work'},
 {id:'H2-PHYSICAL-unknown-prefix-RUN',command:'if; cd "$d"; tee "$prefix/notes"',cwd:'/work'},
 {id:'H2-PHYSICAL-pwsh',tool:'PowerShell',command:'cd $d; Set-Content -Path HOSTS -Value x',cwd:'/work'},
 {id:'H2-PHYSICAL-pwsh-RUN',tool:'PowerShell',command:'cd $d; Set-Content -Path NOTES -Value x',cwd:'/work'},
);
physicalFullAccessRows.push({id:'H1-OWNER-RAW-TARGETS',command:'touch '+Array.from({length:300},(_,i)=>`/w/n${i}`).join(' '),cwd:'/w'});
physicalFullAccessRows.push(...['hosts','notes'].map(leaf=>({id:`H2-PHYSICAL-PROGRAM-ROOT-${leaf}`,command:`if; tar -tf ./a -C "$d" --rsh-command='tee ${leaf}'`,cwd:'/work'})));

r2Rows.push({id:'E-RAW-NO-REENTRY',command:'if; find . -execdir echo "$(touch hosts)" \\;',cwd:'/work',protect:false});
