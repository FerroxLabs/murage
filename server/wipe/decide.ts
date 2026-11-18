// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RootClass, Value, Verdict, WipeEffect } from './types.ts';
/** Pure decision table: the injected classifier owns all path and device IO. */
export function decide(effects:WipeEffect[],classifier:{classify(v:Value,follow?:boolean):RootClass|undefined;isDevice(v:Value):boolean}):Verdict {
 for(const effect of effects){
  if(effect.k==='write'||effect.k==='delete'&&effect.recursive===false)continue;
  if(effect.k==='disk-tool'||effect.k==='device-write'&&classifier.isDevice(effect.target))return {k:'card',rule:'disk-erase',what:'This would erase or repartition a disk. Run it anyway?',effect};
  if(effect.k==='device-write')continue;
  const targets=effect.k==='uncertain-operands'?effect.words:effect.k==='move-away'?[effect.source]:effect.k==='sync-wipe'?[effect.dest]:effect.k==='delete'||effect.k==='git-clean'?[effect.target]:[];
  for(const target of targets){
   const follow=effect.k==='uncertain-operands'&&effect.program==='rm'&&target.k==='known'&&(target.wholeDirGlob||/[\\/]$|[\\/]\.$/.test(target.s))?true:'follow'in effect?effect.follow:undefined;
   const root=classifier.classify(target,follow);if(!root||effect.k==='git-clean'&&root==='project-root'||root==='project-root'&&target.k==='known'&&target.dirsOnly)continue;
   const rule=root==='fs-root'||root==='drive-root'?'delete-root':root==='home'||root==='homes-parent'?'delete-home':'delete-system-folder';
   const description=({'fs-root':'the whole filesystem','drive-root':'a whole drive','home':'your whole home folder','homes-parent':'the home folders','os-dir':'a whole operating system folder','murage-data':'all Murage data','project-root':'your whole project folder'} as const)[root];
   return {k:'card',rule,what:effect.k==='move-away'?`This would move ${description} away. Run it anyway?`:`This would wipe ${description}. Run it anyway?`,effect,root};
  }
 }
 return {k:'run'};
}
export const faultVerdict=():Extract<Verdict,{k:'card'}>=>({k:'card',rule:'wipe-check-fault',what:"Murage couldn't finish checking this command for a whole-drive wipe. Run it anyway?"});
