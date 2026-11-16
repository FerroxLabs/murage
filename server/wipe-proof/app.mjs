// Fixture endpoint only. Owner wg-proof (both sides); production callback wg-callback.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { within } from './safety.mjs';
import { nativeFixturePath } from './adapter.mjs';
export async function startApp(socket, root, token, threadId) {
  const requests = [], faults = [], connections = new Set();
  let script = ['deny'];
  const server = net.createServer(connection => {
    connections.add(connection); connection.on('close', () => connections.delete(connection));
    connection.on('error', () => {});
    let input = '';
    connection.on('data', chunk => {
      input += chunk;
      if (input.length > 65536) { faults.push('oversized'); connection.destroy(); return; }
      if (!input.includes('\n')) return;
      try {
        const request = JSON.parse(input.split('\n')[0]);
        if (request.v !== 1 || request.kind !== 'wipe-exec' || typeof request.id !== 'string' ||
            request.token !== token || request.threadId !== threadId || !Array.isArray(request.argv) ||
            !request.argv.every(x => typeof x === 'string') || typeof request.tool !== 'string' ||
            typeof request.cwd !== 'string' || !within(root, nativeFixturePath(request.cwd)) ||
            !Array.isArray(request.targets) || !request.targets.every(x => typeof x === 'string' && within(root, nativeFixturePath(x))))
          throw Error('request-contract');
        if (requests.some(x => x.id === request.id)) throw Error('duplicate-id');
        requests.push(request);
        const action = script.length > 1 ? script.shift() : script[0];
        if (action === 'disconnect') { connection.destroy(); return; }
        const reply = { id: action === 'wrong-id' ? randomUUID() : request.id, decision: action };
        connection.end(JSON.stringify(reply) + '\n');
      } catch { faults.push('request-contract'); connection.destroy(); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  return { requests, faults,
    script(actions) { script = [...actions]; },
    async close() {
      for (const connection of connections) connection.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
