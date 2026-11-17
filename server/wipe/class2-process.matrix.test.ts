// SPDX-License-Identifier: AGPL-3.0-or-later
// Class 2: what a shell process inherits. Hand-written from bash(1) (SHELLOPTS, set -u, export, export -f),
// POSIX sh, zsh(1) (NO_UNSET), tcsh(1) ("Undefined variable" aborts the command) and fish(1) (an unset variable
// expands to zero words; inside double quotes to an empty string). Never generated from server/wipe/process.ts.
import {expect,it} from 'vitest';
import {row,runMatrix,type Row} from './matrix.fixture.ts';
const rows:Row[]=[];
const UNSET='rm -rf "$BUILD_DIR"/*',DEFAULT='rm -rf "${BUILD_DIR:-build}"/*',EMPTYOK='rm -rf "${BUILD_DIR-}"/*';
// Transitions that stay inside the shell (same process or a subshell): `set` options are inherited.
const inside:[name:string,wrap:(body:string)=>string][]=[
 ['plain',b=>b],['group',b=>`{ ${b}; }`],['function',b=>`f(){ ${b}; }; f`],['eval',b=>`eval '${b}'`],
 ['subshell',b=>`( ${b} )`],['substitution',b=>`echo $( ${b} )`],['pipeline',b=>`true | ${b}`],['background',b=>`${b} &`],['and-list',b=>`true && ${b}`],
];
const parentOptions:[prefix:string,nounset:boolean][]=[['',false],['set -u; ',true],['set -o nounset; ',true],['set -euo pipefail; ',true],['set -eu; ',true],['set -u; set +u; ',false],['set -o nounset; set +o nounset; ',false],['set -e; ',false],['set -o pipefail; ',false]];
for(const [,wrap] of inside)for(const [prefix,nounset] of parentOptions){
 rows.push(row(nounset?'R':'C',prefix+wrap(UNSET)));
 rows.push(row('R',prefix+wrap(DEFAULT)));
}
// ${x-} is exempt from nounset and expands empty: the wipe of /* happens either way.
for(const [prefix] of parentOptions)rows.push(row('C',prefix+EMPTYOK));
// A new process starts from the host's defaults plus its own argv options. The parent's `set -u` does not cross.
const hosts:[spelling:string,nounset:boolean][]=[
 ['bash -c',false],['sh -c',false],['zsh -c',false],['dash -c',false],['ksh -c',false],
 ['bash -u -c',true],['bash -o nounset -c',true],['bash -euo pipefail -c',true],['bash -eu -c',true],['bash -uc',true],['bash -c -u',true],
 ['bash +u -c',false],['bash -u +u -c',false],['bash -o nounset +o nounset -c',false],['bash -e -c',false],['bash -o pipefail -c',false],['bash -o errexit -c',false],
 ['sh -u -c',true],['dash -u -c',true],['ksh -o nounset -c',true],['zsh -u -c',true],['zsh -o nounset -c',true],['zsh --no-unset -c',true],['zsh --nounset -c',true],['zsh -o errexit -c',false],
 ['sudo bash -u -c',true],['env bash -o nounset -c',true],['sudo sh -c',false],['su -c',false],['timeout 5 bash -u -c',true],
];
for(const [host,nounset] of hosts)for(const prefix of ['','set -u; ','set -o nounset; ','set -euo pipefail; ']){
 rows.push(row(nounset?'R':'C',`${prefix}${host} '${UNSET}'`));
 rows.push(row('R',`${prefix}${host} '${DEFAULT}'`));
}
// bash passes its options to a child bash only through an exported SHELLOPTS.
rows.push(row('R',`set -u; export SHELLOPTS; bash -c '${UNSET}'`),row('R',`export SHELLOPTS; set -u; bash -c '${UNSET}'`),row('C',`set -e; export SHELLOPTS; bash -c '${UNSET}'`),row('C',`export SHELLOPTS; bash -c '${UNSET}'`));
// The child sets it itself.
rows.push(row('R',`bash -c 'set -u; ${UNSET}'`),row('R',`sh -c 'set -eu; ${UNSET}'`),row('C',`bash -c 'set -u; set +u; ${UNSET}'`),row('C',`bash -u -c 'set +u; ${UNSET}'`));
// Other new-process routes.
rows.push(row('C',`set -u; echo x | xargs sh -c '${UNSET}'`),row('R',`echo x | xargs sh -u -c '${UNSET}'`),row('C',`set -u; find . -maxdepth 0 -exec sh -c '${UNSET}' \;`),row('C',`set -u; nohup sh -c '${UNSET}'`),row('C',`set -u; env sh -c '${UNSET}'`));
// csh / tcsh always stop on an undefined variable; fish drops the whole word unless it is quoted.
rows.push(row('R',`csh -c '${UNSET}'`),row('R',`tcsh -c '${UNSET}'`),row('R',`tcsh -fc 'rm -rf $BUILD_DIR/*'`),row('C',`csh -c 'rm -rf /etc'`),
 row('R',`fish -c 'rm -rf $BUILD_DIR/*'`),row('C',`fish -c '${UNSET}'`),row('R',`fish -c 'rm -rf $BUILD_DIR'`),row('C',`fish -c 'rm -rf $HOME'`),row('C',`csh -c 'rm -rf $HOME'`));
// Variables: only exported ones reach a new process. A non-exported value is unset there.
const child=`'rm -rf "$D"/*'`;
for(const host of ['bash -c','sh -c','zsh -c','sudo bash -c','env sh -c']){
 rows.push(row('C',`D=/tmp/b; ${host} ${child}`),row('R',`export D=/tmp/b; ${host} ${child}`),row('R',`D=/tmp/b; export D; ${host} ${child}`),row('R',`D=/tmp/b ${host} ${child}`),
  row('R',`declare -x D=/tmp/b; ${host} ${child}`),row('R',`set -a; D=/tmp/b; ${host} ${child}`),row('R',`D=/tmp/b; ${host.replace(' -c',' -u -c')} ${child}`),row('C',`export D=/home/u; ${host} ${child}`),row('C',`D=/home/u ${host} ${child}`));
}
for(const [,wrap] of inside){rows.push(row('R',`D=/tmp/b; ${wrap('rm -rf "$D"/*')}`),row('C',`D=/home/u; ${wrap('rm -rf "$D"/*')}`));}
rows.push(row('R',`export D=/tmp/b; bash -c 'bash -c "rm -rf \\"\\$D\\"/*"'`),row('C',`D=/tmp/b; bash -c 'bash -c "rm -rf \\"\\$D\\"/*"'`),row('C',`bash -c 'D=/tmp/b; bash -c "rm -rf \\"\\$D\\"/*"'`),row('R',`bash -c 'export D=/tmp/b; bash -c "rm -rf \\"\\$D\\"/*"'`));
// Functions: a child process does not see a function that was not exported, so the real program runs.
for(const host of ['bash -c','sh -c','zsh -c','sudo sh -c','env bash -c','nohup bash -c'])rows.push(row('C',`rm(){ :; }; ${host} 'rm -rf ~'`),row('C',`rm(){ echo no; }; ${host} 'rm -rf /etc'`),row('C',`function rm { :; }; ${host} 'rm -rf ~'`));
for(const [name,wrap] of inside)if(name!=='eval')rows.push(row('R',`rm(){ :; }; ${wrap('rm -rf ~')}`));
rows.push(row('R',`rm(){ :; }; eval 'rm -rf ~'`),row('C',`f(){ rm -rf ~; }; export -f f; bash -c f`),row('C',`f(){ rm -rf ~; }; f`),row('C',`f(){ rm -rf ~; }; ( f )`),row('C',`rm(){ :; }; echo x | xargs sh -c 'rm -rf ~'`),row('C',`rm(){ :; }; command rm -rf ~`),row('C',`rm(){ :; }; env rm -rf ~`),row('C',`rm(){ :; }; sudo rm -rf ~`));
// cmd: delayed expansion is per process (/v:on), never inherited by `cmd /c`.
rows.push(row('C','set D=C:\\Users& cmd /v:on /c rd /s /q !D!','cmd','win32'),row('C','setlocal enabledelayedexpansion & set D=C:\\Users& rd /s /q !D!','cmd','win32'),row('R','setlocal enabledelayedexpansion & cmd /c rd /s /q !NOPE!','cmd','win32'),row('R','cmd /c rd /s /q %NOPE%','cmd','win32'));
it('class 2: process state and inheritance',()=>{expect(rows.length).toBeGreaterThan(450);expect(runMatrix('class2',rows)).toEqual([]);});
