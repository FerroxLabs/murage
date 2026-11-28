// SPDX-License-Identifier: AGPL-3.0-or-later
// Comms fixture consumer owner: new3-g2d. Native relay producer owner: tri3-g1.
// Observe server-side depth independently of the fake engine's scripted reply.
// The depth is no longer in the engine env (depth is read from the token record, L2W #5768): the observer asks the
// real internal route which body depth the token's record accepts (the route's cross-check answers 403 "different turn depth").
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
        // A probe is an internal request, which consumes a Chief proposal's binding: only the bots the test names are probed.
        const fs = await import('node:fs');
        let probed = false;
        try { probed = JSON.parse(fs.readFileSync(process.env.MURAGE_TEST_COMMS_OBSERVATIONS + '.probe-bots', 'utf8')).includes(env.MURAGE_BOT_ID); } catch {}
        const wireLeak = Object.values(relay.servers).some(server =>
          ['MURAGE_BOT_ID', 'MURAGE_THREAD_ID', 'MURAGE_TURN_DEPTH'].some(key => key in server.env));
        // off the mount path: the probe must not delay the turn it observes
        void (async () => {
        const accepted = [];
        if (probed)
        for (let probe = 0; probe <= 3; probe++) {
          const answer = await fetch(env.MURAGE_HARNESS_URL + '/api/internal/ask-bot', { method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.MURAGE_COMMS_TOKEN },
            body: JSON.stringify({ fromBotId: env.MURAGE_BOT_ID, fromThreadId: env.MURAGE_THREAD_ID, depth: probe }) });
          if (!/different turn depth/.test(await answer.text())) accepted.push(probe);
        }
        (await import('node:fs')).appendFileSync(process.env.MURAGE_TEST_COMMS_OBSERVATIONS, JSON.stringify({
          botId: env.MURAGE_BOT_ID, threadId: env.MURAGE_THREAD_ID, claimDepths: accepted,
          privateWireFields: wireLeak
        }) + '\\n');
        })().catch(() => {});
      }
` + anchor) };
} });
