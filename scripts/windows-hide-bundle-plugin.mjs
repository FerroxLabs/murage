// Keep the installer external and relocatable. Inlining it loses __filename,
// which descendants need for their first CommonJS --require preload.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../shared/', import.meta.url));
export function windowsHideBundlePlugin() {
 return {
  name: 'windows-hide-preload',
  setup(build) {
   build.initialOptions.metafile = true;
   build.onResolve({filter: /(?:^murage:windows-hide$|win-hide-child-process\.mjs$)/}, () => ({path:'murage:windows-hide',external:true}));
   build.onEnd(result => {
    if(result.errors.length) return;
    const root=resolve(build.initialOptions.outdir ?? dirname(build.initialOptions.outfile));
    const shared=join(root,'shared');mkdirSync(shared,{recursive:true});
    for(const name of ['win-hide-child-process.mjs','win-hide-child-process.cjs']) copyFileSync(join(source,name),join(shared,name));
    for(const output of Object.keys(result.metafile.outputs)) {
     if(!/\.[cm]?js$/.test(output)) continue;
     const file=resolve(build.initialOptions.absWorkingDir ?? process.cwd(), output);
     let specifier=relative(dirname(file),join(shared,'win-hide-child-process.mjs')).split('\\').join('/');
     if(!specifier.startsWith('.')) specifier='./'+specifier;
     const memory=result.outputFiles?.find(item => item.path === file);
     const text=memory ? memory.text : readFileSync(file,'utf8');
     const updated=text.replaceAll('"murage:windows-hide"',JSON.stringify(specifier));
     if(memory) memory.contents=new TextEncoder().encode(updated);
     else writeFileSync(file,updated);
    }
   });
  },
 };
}
