// afterSign: executable hashes must describe the signed bytes handed to users.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBuildCommit } from './build-commit.mjs';
export function writeWindowsHideManifest(root, buildCommit = resolveBuildCommit()) {
 const embedded=JSON.parse(readFileSync(join(root,'resources/ui/build-commit.json'),'utf8')).commit;
 if(!/^[0-9a-f]{40}$/.test(buildCommit ?? '') || embedded !== buildCommit) throw Error('Package build commit mismatch');
 const files=['Murage.exe','resources/app.asar','resources/ui/build-commit.json'];
 const walk=dir=>{for(const item of readdirSync(join(root,dir),{withFileTypes:true})) {
  const file=dir+'/'+item.name;
  if(item.isSymbolicLink()) throw Error('Package manifest refuses symlinks: '+file);
  if(item.isDirectory()) walk(file);else if(/\.(?:[cm]?js|ts)$/i.test(file)) files.push(file);
 }};
 walk('resources');
 if(!files.some(f=>f.startsWith('resources/server/')&&f.endsWith('.js'))) throw Error('Missing bundled server entries');
 const manifest={schema:1,commit:embedded,files:[...new Set(files)].sort().map(path=>({path,sha256:createHash('sha256').update(readFileSync(join(root,path))).digest('hex')}))};
 writeFileSync(join(root,'resources/windows-hide-package-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 return manifest;
}
export default function afterSign(context) {
 if(context.electronPlatformName === 'win32') writeWindowsHideManifest(context.appOutDir);
}
