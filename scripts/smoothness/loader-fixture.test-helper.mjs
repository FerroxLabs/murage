// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture producer and native-preflight consumer owner: c4-misc-b.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
// Copy the product loader with every repository module it loads at run time.
export function copyLoaderModules(work,entry) {
  const pending=[entry],seen=new Set();
  while(pending.length) {
    const name=pending.pop();
    if(seen.has(name))continue;
    seen.add(name);
    const text=readFileSync(resolve(name),'utf8');
    mkdirSync(dirname(join(work,name)),{recursive:true});
    writeFileSync(join(work,name),text);
    for(const [,spec] of text.matchAll(/^\s*(?:import|export)(?!\s+type\b)[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/gm))
      pending.push(join(dirname(name),spec));
  }
}
