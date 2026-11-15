// SPDX-License-Identifier: AGPL-3.0-or-later
// Named mutation witnesses for the shared layers of classes 1, 2 and 5 (mutants.mjs rows MU-C1-*, MU-C2-*, MU-C5-*).
// Each test is the smallest hand-written row set that a regression of one invariant turns red.
import {expect,it} from 'vitest';
import {row,runMatrix,type Row} from './matrix.fixture.ts';
const witness=(name:string,rows:Row[])=>it(name,()=>expect(runMatrix(name,rows)).toEqual([]));
witness('MU-C1-1 su reads its command wherever the user name stands',[row('C',"su root -c 'rm -rf /etc'"),row('C',"su -c 'rm -rf /etc' root"),row('R',"su root -c 'rm -rf ./build'")]);
witness('MU-C1-2 source options are read inside a bundle',[row('C',`python3 -uc 'import shutil; shutil.rmtree("/home/u")'`),row('C',`perl -we 'system("rm -rf /etc")'`),row('R',`python3 -uc 'import shutil; shutil.rmtree("dist")'`)]);
witness('MU-C1-3 a host option outside the table does not end the reading',[row('C',"zsh --no-rcs -c 'rm -rf ~'"),row('R',"zsh --no-rcs -c 'rm -rf ./build'")]);
witness('MU-C1-4 an unknown wrapper option may take the next word',[row('C','sudo --frob x rm -rf /etc'),row('C','sudo --frob rm -rf /etc'),row('R','sudo --frob x rm -rf ./build')]);
witness('MU-C2-1 a new process does not inherit nounset',[row('C',`set -u; bash -c 'rm -rf "$BUILD_DIR"/*'`),row('R',`set -u; rm -rf "$BUILD_DIR"/*`)]);
witness('MU-C2-2 a host applies its own argv options',[row('R',`bash -o nounset -c 'rm -rf "$BUILD_DIR"/*'`),row('R',`bash -u -c 'rm -rf "$BUILD_DIR"/*'`),row('C',`bash -c 'rm -rf "$BUILD_DIR"/*'`)]);
witness('MU-C2-3 a function that was not exported does not shadow the program in a child',[row('C',"rm(){ :; }; bash -c 'rm -rf ~'"),row('R','rm(){ :; }; rm -rf ~')]);
witness('MU-C2-4 a variable that was not exported is unset in a child',[row('C',`D=/tmp/b; bash -c 'rm -rf "$D"/*'`),row('R',`export D=/tmp/b; bash -c 'rm -rf "$D"/*'`)]);
witness('MU-C5-1 a cmd for list is read to its last item',[row('C','for %d in (b1 b2 b3 b4 b5 b6 b7 b8 C:\\Users) do rd /s /q %d','cmd','win32'),row('R','for %d in (b1 b2 b3 b4 b5 b6 b7 b8 b9) do rd /s /q %d','cmd','win32')]);
witness('MU-C5-2 a chain of directory changes keeps a protected directory',[row('C','cd /tmp/w0 || cd /tmp/w1 || cd /tmp/w2 || cd /tmp/w3 || cd /home/u || cd /tmp/w5 || cd /tmp/w6 || cd /tmp/w7; rm -rf ./*'),row('R','cd /tmp/w0 || cd /tmp/w1 || cd /tmp/w2 || cd /tmp/w3 || cd /tmp/w4 || cd /tmp/w5 || cd /tmp/w6 || cd /tmp/w7; rm -rf ./*')]);
witness('MU-C5-3 a nest past the depth limit is still read',[row('C','cmd /c '.repeat(40)+'rd /s /q C:\\Users','cmd','win32'),row('R','cmd /c '.repeat(40)+'rd /s /q build','cmd','win32')]);
witness('MU-C5-4 an argv past the depth limit is still read',[row('C','echo /etc | '+'xargs '.repeat(40)+'rm -rf'),row('R','echo ./build | '+'xargs '.repeat(40)+'rm -rf')]);
witness('MU-C5-5 a literal loop list is never capped',[row('C','for d in /tmp /scratch /cache /build /home/other /output; do rm -rf "$d"; done'),row('C','for d in a b c d etc f g; do rm -rf "/$d"; done'),row('R','for d in a b c d e f; do rm -rf "/tmp/$d"; done')]);
