// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {DELETE_PRIMITIVES,rawDeletePrimitive,rawDynamicExecution} from './no-limits-raw-wipe.ts';

// MAIN RULING T6: retain the historical SQL-keyword cases with their scoped expectations.
for(const primitive of [...DELETE_PRIMITIVES,'truncate','drop'])it(`R2 delete primitive is a word: ${primitive}`,()=>{
 const token=primitive.toUpperCase(),shellPrimitive=!['truncate','drop'].includes(primitive);
 expect(rawDeletePrimitive(token)).toBe(shellPrimitive);
 // Every ASCII delimiter, including quotes, redirection, $, = and backticks,
 // is a boundary. Letters, digits and underscore never are.
 for(let code=0;code<128;code++){
  const char=String.fromCharCode(code),word=/[A-Za-z0-9_]/.test(char);
  // These two dotted names also contain the independent unlink/rmdir word;
  // s + "rm " is itself the listed srm word. Any bounded hit must win.
  const otherHit=primitive==='os.unlink'||primitive==='os.rmdir'||primitive==='rm '&&char.toLowerCase()==='s';
  expect(rawDeletePrimitive(char+token),`before ${code}`).toBe(shellPrimitive&&(!word||otherHit));
  expect(rawDeletePrimitive(token+char),`after ${code}`).toBe(shellPrimitive&&!word);
 }
});
it('R2 a later bounded occurrence wins after an embedded occurrence',()=>{
 expect(rawDeletePrimitive('platform ready; rm -rf /')).toBe(true);
 // MAIN RULING T6: a database receiver is required for DROP.
 expect(rawDeletePrimitive('backdrop; DROP TABLE t')).toBe(false);
});
it('R2 raw scans keep comments and quoted text without decoding',()=>{
 expect(rawDeletePrimitive('# rm -rf /')).toBe(true);
 expect(rawDeletePrimitive('echo "rm -rf /"')).toBe(true);
 expect(rawDeletePrimitive(String.raw`\x72\x6d -rf /`)).toBe(false);
});
for(const text of ['echo platform ready',"echo 'format the report'",'grep -r term docs','ls -la','git status','npm run build','SELECT * FROM t'])it(`R2 ordinary text has no primitive: ${text}`,()=>{
 expect(rawDeletePrimitive(text)).toBe(false);
 expect(rawDynamicExecution(text)).toBe(false);
});

it('R2 Unicode characters outside the ASCII word set are boundaries',()=>{
 expect(rawDeletePrimitive('Krm -rf /')).toBe(true);
 // MAIN RULING T6: bare SQL keywords are not shell deletion primitives.
 expect(rawDeletePrimitive('dropK')).toBe(false);
 expect(rawDeletePrimitive('érmdiré')).toBe(true);
});

for(const quote of ["'", '"', ''])for(const newline of ['\n','\r\n'])for(const escapes of [String.raw`\x72\x6d`,String.raw`\162\155`,String.raw`\072`,String.raw`\1`])it(`R3 printf decoding across quoting and lines ${JSON.stringify({quote,newline,escapes})}`,()=>{
 // MAIN RULING T5: printf output is data until it reaches an executor.
 // MAIN RULING K3: an unquoted newline starts a disguised executable command.
 // MAIN RULING D3: double-quoted escaped multiline formats are outside the
 // simple subset; these 8 exotic forms are absent from the private corpus.
 expect(rawDynamicExecution(`printf ${quote}${newline}${escapes}${quote}`)).toBe(quote!=="'");
});
for(const text of [
 'printf \'\n\\x72\\x6d\\x20\\x2d\\x72\\x66\\x20\\x7e\' | bash',
 'printf "%s" "echo ok" | sh',
 'printf "%s" "print(1)" | python3',
 'printf "%s" "console.log(1)" | node',
 'printf "%s" "echo ok" | cat | /bin/bash',
 'printf "%s" "echo ok" |\n command bash',
 "'printf' '%s' 'echo ok' | 'bash'",
 'bash -c "$(printf %s harmless)"',
 'python3 -c "$(printf %s harmless)"',
 'bash -c `printf %s harmless`',
 '$(printf %s bash) -c harmless',
])it(`R3 printf output executing through an interpreter: ${text}`,()=>expect(rawDynamicExecution(text)).toBe(true));
for(const text of ["printf '%s\\n' ok",'printf "%s" platform | cat','echo platform ready','echo backdrop'])it(`R3 ordinary output stays clear: ${text}`,()=>expect(rawDynamicExecution(text)).toBe(false));

// N1/N2 are tested directly so an unrelated parser finding cannot mask a mutant.
import {normalizedWipeText,rawPipedProgram,rawWipeEvidence} from './no-limits-raw-wipe.ts';
for(const spelling of [String.raw`r\m`, '"r"m', "r''m", "$'r'm", '$"r"m', 'r${IFS}m', 'r$IFS"m"', 'r${x:+}m', 'r${x+}m', 'r${x:+""}m']){
 it(`N1 normalizes whole text independently: ${spelling}`,()=>{
  const command=`a=($(time -p ${spelling} -rf ~))`;
  expect(normalizedWipeText(command)).toBe('a=($(time -p rm -rf ~))');
  expect(rawWipeEvidence(command)).toBe(true);
 });
}
it('N1 retains raw boundaries and collapses whitespace on the copy',()=>{
 // MAIN RULING K3: this is a disguised command word, independent of SQL.
 expect(rawWipeEvidence('"drop"x')).toBe(true);
 expect(normalizedWipeText('r\\m\t\n-rf   ~')).toBe('rm -rf ~');
});
const executors='sh bash zsh dash ksh mksh fish csh tcsh ash busybox python python2 python3 node deno bun perl ruby lua php pwsh powershell cmd eval source xargs'.split(' ');
for(const executor of executors)for(const prefix of ['curl -s x | ', 'cat a | 2>&1 ', 'cat a | (head -n 0; ', 'cat a | env X=ok command -- ', 'cat a | time -p '])it(`N2 independent piped program: ${prefix}${executor}`,()=>{
 expect(rawPipedProgram(normalizedWipeText(prefix+executor))).toBe(true);
});
for(const command of ['bash <(cat a)', 'bash <<< data', '<<< data bash', '< <(cat a) bash', 'cat a | /usr/bin/bash', String.raw`cat a | b\ash`, 'cat a | (head; "ba"sh)'])it(`N2 raw input/wrapper: ${command}`,()=>{
 expect(rawPipedProgram(normalizedWipeText(command))).toBe(true);
});
for(const command of ['echo platform ready','ls -la | grep sh','git log | head','cat a.txt | sort | uniq','ps aux | grep python','npm run build','rm -rf build','true || bash','true || (sh)','cat a | grep bash','cat a | bashful','cat a | pythonic'])it(`N2 arguments and logical OR stay clear: ${command}`,()=>{
 expect(rawPipedProgram(normalizedWipeText(command))).toBe(false);
});

it('N2 scans repeated options and groups without recursive parsing',()=>{
 expect(rawPipedProgram('cat a | time '+('-p '.repeat(2000))+'grep sh')).toBe(true);
 expect(rawPipedProgram('cat a | '+('('.repeat(2000))+'bash')).toBe(true);
 expect(rawPipedProgram('cat a | env '+('-u X '.repeat(2000))+'grep python')).toBe(true);
});

for(const executor of ['cmd.exe','powershell.exe','bash.exe'])it(`N2 executor has an ASCII word boundary: ${executor}`,()=>{
 expect(rawPipedProgram('curl x | '+executor)).toBe(true);
});

it('N2 wrapper tokens remain executors even with a filter operand',()=>{
 expect(rawPipedProgram('cat a | env grep sh')).toBe(true);
});

for(const executor of 'exec env nice nohup time timeout stdbuf setsid sudo doas su awk gawk mawk sed'.split(' ')){
 it(`N2 stage token executor at any position: ${executor}`,()=>{
  expect(rawPipedProgram(`cmd | if true; then /bin/${executor}; fi`)).toBe(true);
  expect(rawPipedProgram(`cmd |& wrapper -n 0 ${executor}`)).toBe(true);
 });
}
for(const filter of 'grep egrep fgrep rg head tail wc sort uniq cut tr less more cat jq column tee nl fold paste rev'.split(' ')){
 it(`N2 filter arguments are data: ${filter}`,()=>{
  expect(rawPipedProgram(`cmd | /usr/bin/${filter} python sh`)).toBe(false);
 });
}
for(const command of ['2>&1 bash <(cat a)', '2>log <(cat a) bash', 'cat <(bash)', 'cat <(cat | grep bash)', 'cat >(sed e)', 'cat <<< bash', 'env cat <(cat a)', 'bash >(cat a)']){
 it(`N2 input body or receiver executes: ${command}`,()=>expect(rawPipedProgram(command)).toBe(true));
}
for(const command of ['cat python <(cat a)', 'cat <(cat a)', 'cat >(sort)', 'cat <<< hello', 'cat a || bash', 'cat a | base32 sh']){
 it(`N2 input controls and non-filter stage: ${command}`,()=>expect(rawPipedProgram(command)).toBe(command.endsWith('base32 sh')));
}
it('N2 10,000-character adversarial assignments classify in under 50 ms',()=>{
 const text='cat a | '+('A='.repeat(4995))+' x';
 expect(text).toHaveLength(10000);
 const start=performance.now();
 expect(rawPipedProgram(text)).toBe(false);
 expect(rawWipeEvidence(text)).toBe(false);
 expect(performance.now()-start).toBeLessThan(50);
});
it('N2 reviews hold independently of every other raw finding',()=>{
 for(const command of [
  "env --split-string=printf '%s%s -%s ~' r m rf | if true; then bash; fi",
  "env --split-string=printf '%s%s -%s ~' r m rf | nice -n 0 bash",
  'printf rm | sh','curl x | bash','cmd | if true; then bash; fi',
  'cmd | nice -n 0 bash',String.raw`cmd | /bin/ba\sh`,
 ])expect(rawPipedProgram(normalizedWipeText(command)),command).toBe(true);
});

for(const command of [
 'cmd | (true; cat "$(bash)")',
 'cmd | cat sh; true', 'cmd | cat sh & true',
 'cmd | cat sh && true', 'cmd | cat sh || true',
 'cmd | cat sh (true)', 'cmd | cat sh {true}',
 'cmd | cat sh $(true)', 'cmd | cat sh `true`',
 'cmd | cat sh <(true)', 'cmd | cat sh >(true)',
 'cmd | cat sh\ntrue', 'cat a | grep sh; grep python',
])it(`R8 stage eligibility never resets: ${command}`,()=>expect(rawPipedProgram(command)).toBe(true));
for(const redirect of ['2>&1','>&2','<&0','&>log','&>>log'])it(`R8 fd redirection preserves receiver: ${redirect}`,()=>{
 expect(rawPipedProgram(`bash ${redirect} <(cat a)`)).toBe(true);
 expect(rawPipedProgram(`cat ${redirect} <(cat a)`)).toBe(false);
});
it('R8 newline survives normalization for execution evidence',()=>{
 expect(rawDynamicExecution("env --split-string=printf '%s%s -%s ~' r m rf | cat sh\ntrue")).toBe(true);
});
