// SPDX-License-Identifier: AGPL-3.0-or-later
// Recall construction producer owner: recall-scope; fixture consumer: c4-misc-a2.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
let sequence=0;
/** Acknowledges actual structural preparation outside the measured turn. */
export async function prepareFixtureRecall(dataDir:string,botId:string,threadId:string):Promise<void> {
  const directory=dirname(dataDir),seq=++sequence;
  writeFileSync(join(directory,'recall-ready-control.json'),JSON.stringify({seq,botId,threadId}));
  const deadline=Date.now()+30_000;
  while (Date.now()<deadline) {
    let result;
    try { result=JSON.parse(readFileSync(join(directory,'recall-ready-result.json'),'utf8')); } catch { /* not published */ }
    if (result?.seq===seq) {
      if (result.ready===true) return;
      throw Error(`Fixture recall preparation failed: ${result.error}`);
    }
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('Fixture recall preparation did not finish');
}
