// Sentinel copies its scanner out of the package. Keep the require preload
// beside that immutable scanner, with content-addressed names for rollback.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function sentinelWindowsHideFiles(source, bytes) {
 const text=bytes.toString('utf8');
 const specifier='../shared/win-hide-child-process.mjs';
 if(!text.includes(JSON.stringify(specifier))) return {entry:bytes,files:[]};
 const shared=path.resolve(path.dirname(source),'../shared');
 const cjs=readFileSync(path.join(shared,'win-hide-child-process.cjs'));
 const cjsName=`win-hide-${digest(cjs)}.cjs`;
 const mjs=Buffer.from(readFileSync(path.join(shared,'win-hide-child-process.mjs'),'utf8')
  .replace("'./win-hide-child-process.cjs'",JSON.stringify('./'+cjsName)));
 const mjsName=`win-hide-${digest(mjs)}.mjs`;
 return {entry:Buffer.from(text.replaceAll(JSON.stringify(specifier),JSON.stringify('./'+mjsName))),files:[{name:cjsName,bytes:cjs},{name:mjsName,bytes:mjs}]};
}
