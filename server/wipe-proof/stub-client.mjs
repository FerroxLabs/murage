// Contract fixture (wg-proof), not the production client (wg-callback).
import fs from 'node:fs/promises';
import net from 'node:net';
try {
  const guard = JSON.parse(await fs.readFile(process.env.MURAGE_WIPE_GUARD, 'utf8'));
  if (process.argv[2] !== 'wipe-exec') throw Error('operation');
  const request = JSON.parse(process.argv[3]);
  if ('token' in request) throw Error('token-in-argv');
  request.token = guard.token;
  await new Promise(resolve => {
    const socket = net.createConnection(guard.socket);
    const timer = setTimeout(() => { socket.destroy(); process.exitCode = 11; resolve(); }, 12000);
    let line = '';
    const finish = code => { clearTimeout(timer); process.exitCode = code; socket.destroy(); resolve(); };
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      line += chunk;
      if (!line.includes('\n')) return;
      try { const reply = JSON.parse(line.split('\n')[0]); finish(reply.id !== request.id ? 11 : reply.decision === 'allow' ? 0 : reply.decision === 'deny' ? 10 : 11); }
      catch { finish(11); }
    });
    socket.on('error', () => finish(11)); socket.on('end', () => finish(process.exitCode ?? 11));
  });
} catch { process.exitCode = 11; }
