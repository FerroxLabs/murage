// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {rawDeletePrimitive,rawDynamicExecution} from '../shared/no-limits-raw-wipe.ts';
// Independent literal oracle: never derive required cases from DELETE_PRIMITIVES.
// MAIN RULING T6: retain the historical SQL-keyword cases with their scoped expectations.
const primitives=[
 'rm ', 'rmdir', 'unlink', 'shred', 'srm', 'Remove-Item', 'ri ', 'del ',
 'erase', 'rd ', '-delete', 'git clean', 'dd ', 'mkfs', 'wipefs',
 'diskpart', 'format ', 'rmtree', 'os.remove', 'os.unlink', 'os.rmdir', 'fs.rm',
 'rmSync', 'rimraf', 'unlinkSync', 'File.Delete', 'Directory.Delete',
 'deleteMany', 'deleteOne', 'dropDatabase', 'dropdb', 'dropuser', 'flushall', 'flushdb',
];
for(const primitive of [...primitives,'truncate','drop'])it(`R9 bounded primitive ${primitive}`,()=>{
 const token=primitive.toUpperCase(),shellPrimitive=!['truncate','drop'].includes(primitive);
 expect(rawDeletePrimitive(token)).toBe(shellPrimitive);
 for(const adjacent of ['a','Z','0','_']){
  // os.unlink/os.rmdir also contain the independently bounded leaf primitive.
  expect(rawDeletePrimitive(adjacent+token)).toBe(shellPrimitive&&(primitive==='os.unlink'||primitive==='os.rmdir'));
  expect(rawDeletePrimitive(token+adjacent)).toBe(false);
 }
 for(const adjacent of [';','|','&','<','>','(',')',"'",'"','`','$','=',' ']){
  expect(rawDeletePrimitive(adjacent+token+adjacent)).toBe(shellPrimitive);
 }
});
it('R9 a later primitive cannot be hidden by an embedded occurrence',()=>{
 expect(rawDeletePrimitive('platform ready; rm -rf /')).toBe(true);
 // MAIN RULING T6: SQL keywords need a database receiver.
 expect(rawDeletePrimitive('raindrop; DROP TABLE t')).toBe(false);
});
it('R9 raw inspection retains quoted text, comments and the original marker inventory',()=>{
 expect(rawDeletePrimitive('# rm -rf /')).toBe(true);
 expect(rawDeletePrimitive('echo "rm -rf /"')).toBe(true);
 expect(rawDeletePrimitive(String.raw`\x72\x6d -rf /`)).toBe(false);
 // MAIN RULING T1/T5: data-only heredocs and printf assignments run.
 for(const marker of ['source ./x',"$'hi'"])expect(rawDynamicExecution(marker)).toBe(true);
 for(const marker of ['eval x','printf -v x','cat <<EOF','exec(x)'])expect(rawDynamicExecution(marker)).toBe(false);
});
