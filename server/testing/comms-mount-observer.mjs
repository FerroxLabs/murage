// SPDX-License-Identifier: AGPL-3.0-or-later
// Comms fixture consumer owner: new3-g2d. Native relay producer owner: tri3-g1.
// Observe server-side depth independently of the fake engine's scripted reply.
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (!url.endsWith('/server/drivers/cli-mount-relay.ts')) return loaded;
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
  const anchor = '      return relay;';
  if (source.split(anchor).length !== 2) throw new Error('Comms mount observer anchor moved');
  return { ...loaded, source: source.replace(anchor, `
      const observedAgents = entries.get('agents');
      if (observedAgents && process.env.MURAGE_TEST_COMMS_OBSERVATIONS) {
        const env = observedAgents.env;
        (await import('node:fs')).appendFileSync(process.env.MURAGE_TEST_COMMS_OBSERVATIONS, JSON.stringify({
          botId: env.MURAGE_BOT_ID, threadId: env.MURAGE_THREAD_ID, depth: env.MURAGE_TURN_DEPTH,
          privateWireFields: Object.values(relay.servers).some(server =>
            ['MURAGE_BOT_ID', 'MURAGE_THREAD_ID', 'MURAGE_TURN_DEPTH'].some(key => key in server.env))
        }) + '\\n');
      }
` + anchor) };
} });
