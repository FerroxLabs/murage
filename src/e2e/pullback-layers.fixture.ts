// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// An isolated HTTP/SSE door. No production server, engine, home, or live data.
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { pbConfig, pbAboutMe, pbTimeZone } from './pullback-layers.responses';
import { TERMS_VERSION } from '../../shared/terms';

export const BOT = 'pullback-bot', THREAD = 'pullback-thread', SEND = 'pullback-send';
export class PullbackFixture {
  private vite?: ViteDevServer;
  private streams = new Set<ServerResponse>();
  readonly dataDir = mkdtempSync(join(tmpdir(), 'murage-pullback-'));
  origin = '';
  epoch = 'E1';
  status: 'idle' | 'running' | 'stopped' = 'idle';
  interrupts: unknown[] = [];
  lookups: string[] = [];
  connections = 0;
  private seq = 1;
  sendId = SEND;
  private sendResponses = new Set<ServerResponse>();
  bot(epoch = this.epoch, name = 'Pullback bot', seq = this.seq) {
    return { id: BOT, threadId: THREAD, name, title: 'Fixture helper', description: 'Local fixture', color: 'blue',
      createdAt: 1, messages: [], skills: [], unread: false, notifications: false, resumeCursors: {},
      modelSelection: { instanceId: 'fixture', model: 'fixture' }, tasksEpoch: epoch, tasksSeq: seq, recordSeq: seq,
      tasks: [{ threadId: THREAD, title: 'Fixture task', createdAt: 1, resumeCursors: {} }] };
  }
  frame(frame: object) { for (const stream of this.streams) stream.write(`data: ${JSON.stringify(frame)}\n\n`); }
  delta(text: string) { this.frame({ kind: 'runtime', event: { type: 'content.delta', threadId: THREAD, streamKind: 'assistant_text', delta: text } }); }
  settle(text = 'Stopped fixture turn') {
    this.frame({ kind: 'sends', threadId: THREAD, pending: [] });
    this.frame({ kind: 'message', threadId: THREAD, message: { id: 'user-' + this.seq, role: 'user', kind: 'text', text: 'Fixture turn', sendId: this.sendId, at: Date.now() } });
    this.frame({ kind: 'message', threadId: THREAD, message: { id: `reply-${++this.seq}`, role: 'bot', kind: 'text', text, at: Date.now() } });
    this.frame({ kind: 'runtime', event: { type: 'turn.completed', threadId: THREAD } });
    for (const res of this.sendResponses) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Fixture connection ended' })); }
    this.sendResponses.clear();
  }
  restartEngine() {
    this.epoch = 'E2'; this.seq = 10;
    for (const stream of this.streams) stream.end();
    this.streams.clear();
  }
  announce(epoch: string, name: string, seq: number) { this.frame({ kind: 'bot', bot: this.bot(epoch, name, seq) }); }
  async start() {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    mkdirSync(join(this.dataDir, 'data'));
    const fixture = this;
    this.vite = await createServer({ configFile: false, envFile: false, root, cacheDir: join(this.dataDir, 'cache'),
      resolve: { alias: { '@': join(root, 'src') } }, server: { host: '127.0.0.1', watch: null, hmr: false },
      plugins: [{
        name: 'pullback-observer', enforce: 'pre',
        transform(source, id) {
          if (id.split('?')[0] === join(root, 'src/components/SettingsModal.tsx')) {
            return `import { PullbackControls } from '/src/e2e/pullback-layers.controls';\n` + source.replace('      </div>\n    </div></LayerSurface>', '        <PullbackControls />\n      </div>\n    </div></LayerSurface>');
          }
          if (id.split('?')[0] === join(root, 'src/components/LazyOverlay.tsx')) {
            return source.replace('reload={reload}', 'reload={reload ?? (() => { window.pullbackReloads = (window.pullbackReloads ?? 0) + 1; })}');
          }
          if (id.split('?')[0] !== join(root, 'src/App.tsx')) return;
          // Instrumentation only: App, Shell, provider and every shipped owner remain real.
          return `import { PullbackObserver } from '/src/e2e/pullback-layers.observer';\n` + source.replace('<StoreProvider>', '<StoreProvider><PullbackObserver />').replace('  const closeCalendar =', '  useEffect(() => { window.pullbackWorkspace = (kind) => kind === \"browser\" ? openBrowserWorkspace(\"pullback-bot\") : openLocalVmWorkspace(\"pullback-bot\"); });\n  const closeCalendar =');
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const path = new URL(req.url ?? '/', 'http://fixture').pathname;
            if (path === '/__pullback') {
              res.setHeader('content-type', 'text/html');
              res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/src/e2e/pullback-layers.entry.tsx"></script>'); return;
            }
            if (!path.startsWith('/api/')) return next();
            const json = (body: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
            if (path === '/api/events') {
              fixture.connections++;
              res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
              res.write(`data: ${JSON.stringify({ kind: 'hello', resumed: false })}\n\n`);
              fixture.streams.add(res); req.on('close', () => fixture.streams.delete(res)); return;
            }
            if (path === `/api/bots/${BOT}/interrupt`) {
              let text = ''; for await (const chunk of req) text += chunk;
              fixture.interrupts.push({ method: req.method, body: JSON.parse(text) });
              fixture.status = 'stopped'; json({ ok: true }); return;
            }
            if (path === `/api/bots/${BOT}/messages` && req.method === 'POST') {
              let text = ''; for await (const chunk of req) text += chunk;
              fixture.sendId = JSON.parse(text).sendId;
              fixture.status = 'running'; fixture.sendResponses.add(res);
              fixture.frame({ kind: 'sends', threadId: THREAD, pending: [{ queueId: 'sending:' + fixture.sendId, sendId: fixture.sendId, state: 'sending', text: 'Fixture turn' }] });
              fixture.frame({ kind: 'runtime', event: { type: 'turn.started', threadId: THREAD } });
              fixture.delta('Running fixture turn'); return;
            }
            if (path.startsWith('/api/sends/')) { fixture.lookups.push(path); json({ status: fixture.status === 'stopped' ? 'stopped' : 'started' }); return; }
            if (path === '/api/bots') { json({ bots: [fixture.bot()], groups: [{ id: 'pullback-group', recordEpoch: fixture.epoch, recordSeq: fixture.seq, threadId: 'pullback-group-thread', name: 'Pullback channel', memberIds: [BOT], defaultResponder: { kind: 'mentions' }, bulletin: '', unread: false, createdAt: 1, messages: [] }], computerControl: {}, tasksEpoch: fixture.epoch, removed: [], removedGroups: [], roomClock: fixture.seq }); return; }
            if (path === '/api/packages/import') { json({ archiveSha256: 'fixture', scan: { blocked: false, reviewRequired: false, findings: [] }, agents: [], skills: [], routines: [], instructions: [] }); return; }
            if (path === '/api/packages/export' || path === '/api/teams/export') { json({ bots: [], groups: [], playbooks: [], routines: [], skills: [] }); return; }
            if (path === '/api/section-context') { json({ section: 'fixture', label: 'Fixture team', text: '', updatedAt: null, maxBytes: 24000 }); return; }
            if (path === '/api/terms') { json({ accepted: true, version: TERMS_VERSION }); return; }
            if (path === '/api/config') { json(pbConfig); return; }
            if (path === '/api/about-me') { json(pbAboutMe); return; }
            if (path === '/api/owner/timezone') { json(pbTimeZone); return; }
            if (path === '/api/instances') { json({ instances: [] }); return; }
            if (path === '/api/routines') { json({ routines: [], runs: [] }); return; }
            if (path === '/api/webhooks') { json({ webhooks: [], attempts: [] }); return; }
            if (path === '/api/desktop-secret') { res.statusCode = 404; json({ error: 'Remote fixture' }); return; }
            if (path.includes('/messages')) { json({ messages: [], hasMore: false }); return; }
            if (path.includes('/memory')) { json({ memories: [], items: [], counts: {} }); return; }
            if (path.includes('library') || path.includes('teams')) { json({ teams: [], bundles: [], items: [], profiles: [] }); return; }
            json({ bots: [], groups: [], items: [], skills: [], devices: [], profiles: [], entries: [], notices: [], active: [], counts: {} });
          });
        },
      }, react(), tailwindcss()],
    });
    await this.vite.listen(0);
    const address = this.vite.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Fixture port missing');
    this.origin = `http://127.0.0.1:${address.port}`;
  }
  async close() {
    for (const stream of this.streams) stream.end();
    for (const response of this.sendResponses) response.end();
    await this.vite?.close();
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}
