// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture consumer owner: salv-plus. Execution bus and native relay producer owner: tri3-g1.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Observe real terminal delivery after the folder-lease/fold subscribers.
 * Public SSE deliberately omits native turn identities. This observer never
 * changes an event, grants authority, or releases a lease. Its files live only
 * in the caller's disposable fixture directory. */
export function stoppedTurnFixture(root: string) {
  const events = join(root, 'native-terminal-events.jsonl');
  const preload = join(root, 'stopped-turn-preload.mjs');
  writeFileSync(preload, `import ${JSON.stringify(new URL('./fake-engine-server-preload.mjs', import.meta.url).href)};
import ${JSON.stringify(new URL('./mount-evidence-preload.mjs', import.meta.url).href)};
import {isMainThread} from 'node:worker_threads';
import {registerHooks} from 'node:module';
if(isMainThread) registerHooks({load(url,context,next){
  const loaded=next(url,context);
  if(!url.endsWith('/server/drivers/claude.ts')&&!url.endsWith('/server/index.ts'))return loaded;
  const source=String(loaded.source);
  const anchor=url.endsWith('/server/drivers/claude.ts')
    ? 'extra: { ...ownedTurnNames(env, stripOwned), ...claudeNames,'
    : 'bus.subscribeExecution(foldRuntimeEvent);';
  if(source.split(anchor).length!==2)throw Error('Stopped-turn fixture anchor must match exactly once');
  const addition=url.endsWith('/server/drivers/claude.ts')
    ? " ...Object.fromEntries(Object.entries({...process.env,...env}).filter(([name])=>name.startsWith('FAKE_'))),"
    : 'bus.subscribeExecution(event => { if(event.type === "turn.completed" || event.type === "session.exited") appendFileSync('+${JSON.stringify(JSON.stringify(events))}+', JSON.stringify({kind:"runtime",event:{type:event.type,threadId:event.threadId,turnId:event.turnId}})+String.fromCharCode(10)); });';
  return {...loaded,source:source.replace(anchor,anchor+addition)};
}});
`);
  return {
    args: ['--import', pathToFileURL(preload).href],
    terminalFrame(threadId: string) {
      if (!existsSync(events)) return undefined;
      return readFileSync(events, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line)).find(frame => frame.event.threadId === threadId && frame.event.turnId);
    },
  };
}
