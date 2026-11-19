// SPDX-License-Identifier: AGPL-3.0-or-later
// OWNER premise ruling: MAIN. OWNER shell witnesses: wipe-v3-tests.
// OWNER cross-platform fixture adaptation: c4-misc-a2.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';

// These witnesses execute only inert argument/stdin printers, never deletion.
// MAIN RULING 1114-C4A-WIPE-WINS: run the same shell witnesses on every OS.
// Bash reports physical POSIX paths: resolve macOS temp aliases and Git Bash drives.
const shellPath=(path:string)=>path.replaceAll('\\','/');
const shellDirectory=(path:string)=>shellPath(realpathSync(path))
 .replace(/^([a-z]):\//i,(_match,drive:string)=>`/${drive.toLowerCase()}/`);
it('V3-PREMISE G4 expands caller names before env changes directory',()=>{
 // MAIN RULING WIPE-V3-PREMISE: the caller expands names before the child changes directory.
 const cwd=mkdtempSync(join(tmpdir(),'wipe-premise-'));
 const destination=mkdtempSync(join(tmpdir(),'wipe-premise-target space-'));
 try{
  writeFileSync(join(cwd,'alpha'),'');writeFileSync(join(cwd,'beta'),'');
  writeFileSync(join(destination,'gamma'),'');
  const output=execFileSync('bash',['--noprofile','--norc','-c',
   // MAIN RULING 1114-C4A-WIPE-WINS: GNU env -C is not portable;
   // the real env child changes directory with Bash after its caller expands *.
   `env bash --noprofile --norc -c 'cd -- "$1" || exit; shift; printf "%s\\n" "$(pwd -P)" "$@"' _ "$1" *`,
   '_',shellPath(destination),
  ],{cwd,encoding:'utf8'});
  // MAIN RULING 1114-C4A-WIPE-WINS: physical fixture path, same exact caller operands.
  expect(output).toBe(`${shellDirectory(destination)}\nalpha\nbeta\n`);
 }finally{rmSync(cwd,{recursive:true,force:true});rmSync(destination,{recursive:true,force:true});}
});
it('V3-PREMISE ASKAPI-16 read consumes the line before the shell receives stdin',()=>{
 // MAIN RULING WIPE-V3-PREMISE: read consumes the only line; the fake bash receives EOF.
 const output=execFileSync('bash',['--noprofile','--norc','-c',
  `bash(){ cat; }; echo 'rm -rf ~' | while read x; do printf 'read=<%s>\\n' "$x"; bash; done`,
 ],{encoding:'utf8'});
 expect(output).toBe('read=<rm -rf ~>\n');
});
it('V3-PREMISE REF-2.1-026 quoted star remains one literal operand',()=>{
 // MAIN RULING WIPE-V3-PREMISE: quoted /* cannot expand to root contents.
 const output=execFileSync('bash',['--noprofile','--norc','-c',
  `rm(){ printf '<%s>\\n' "$@"; }; rm -rf "/*"`,
 ],{encoding:'utf8'});
 expect(output).toBe('<-rf>\n</*>\n');
});
it('V3-PREMISE ASKAPI-21 external sudo-style execution cannot change the caller cwd',()=>{
 // MAIN RULING WIPE-V3-PREMISE: cd is a builtin, unavailable to external execution; caller cwd stays.
 const cwd=mkdtempSync(join(tmpdir(),'wipe-premise-'));
 try{
  writeFileSync(join(cwd,'alpha'),'');
  const output=execFileSync('bash',['--noprofile','--norc','-c',
   `sudo(){ env "$@"; }; rm(){ printf 'cwd=<%s>\\n' "$(pwd -P)"; printf '<%s>\\n' "$@"; }; f(){ sudo cd /; }; f; rm -rf *`,
  ],{cwd,encoding:'utf8',stdio:['ignore','pipe','ignore']});
  // MAIN RULING 1114-C4A-WIPE-WINS: compare the unchanged caller's physical shell path.
  expect(output).toBe(`cwd=<${shellDirectory(cwd)}>\n<-rf>\n<alpha>\n`);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
