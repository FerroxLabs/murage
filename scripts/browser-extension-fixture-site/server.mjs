// SPDX-License-Identifier: AGPL-3.0-or-later
// Local fixture site for the Murage for Chrome test batteries (spec section 10.3).
// Binds 127.0.0.1 only, on two ports so cross-origin cases are real cross-origin. Started by the test
// harness through startFixtureSite(); there is no CLI on purpose. Every page records what was clicked,
// changed, submitted, uploaded or downloaded on the server, so a test can assert that nothing happened.
// No external network calls, no third-party scripts.
import http from 'node:http';
import { PAGES, FIXTURE_DATA, widgetPage, itemsSlice, H7_JS, T1_JS, esc } from './pages.mjs';
import { STATIC_FILES } from './static.mjs';

const HOST = '127.0.0.1';
const MAX_BODY = 8 * 1024 * 1024;
const SENSITIVE = /pass|card|cvc|cvv|secret|token|otp|pw/i;
// Kinds that are not "something happened on the page": passive loads and navigation bookkeeping.
const PASSIVE = new Set(['view', 'load', 'nav', 'pagehide', 'scroll-ready', 'csp-violation', 'message', 'download-closed']);

const ALL_STATIC = { ...STATIC_FILES, '/static/h7.js': ['text/javascript', H7_JS], '/static/t1.js': ['text/javascript', T1_JS] };
const PAGE_BY_PATH = new Map(PAGES.map((p) => [p.path, p]));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function redactFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    const s = String(v);
    out[k] = SENSITIVE.test(k) ? { redacted: true, length: s.length } : (s.length > 200 ? { length: s.length, head: s.slice(0, 40) } : s);
  }
  return out;
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const fields = {}; const files = [];
  if (!m) return { fields, files };
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    const part = buf.subarray(pos + boundary.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1) {
      const head = part.subarray(0, split).toString('utf8');
      const data = part.subarray(split + 4);
      const name = /name="([^"]*)"/.exec(head)?.[1];
      const filename = /filename="([^"]*)"/.exec(head)?.[1];
      if (filename !== undefined) files.push({ field: name, filename, size: data.length });
      else if (name) fields[name] = data.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}

/**
 * @typedef {{seq:number, ts:number, kind:string, page:string, origin:string, port:number, detail:object}} FixtureEvent
 */
export async function startFixtureSite() {
  /** @type {FixtureEvent[]} */
  const events = [];
  let seq = 0;
  const ports = { primary: 0, alt: 0 };
  const origins = () => ({ origin: `http://${HOST}:${ports.primary}`, alt: `http://${HOST}:${ports.alt}` });

  function record(kind, page, port, detail = {}) {
    const e = { seq: ++seq, ts: Date.now(), kind, page, origin: `http://${HOST}:${port}`, port, detail };
    events.push(e);
    return e;
  }

  function send(res, status, type, body, headers = {}) {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(body);
  }

  function thanks(id, extra = '') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Received</title><link rel="stylesheet" href="/static/fixture.css"><script src="/static/rec.js" data-page="${esc(id)}-received"></script></head><body data-fixture-page="${esc(id)}-received"><h1>Received</h1><p id="received">submitted:${esc(id)}</p>${extra}<a href="/">Fixture index</a></body></html>`;
  }

  function makeHandler(role) {
    return async (req, res) => {
      const port = role === 'primary' ? ports.primary : ports.alt;
      try {
        // Reject any Host that is not this listener on 127.0.0.1 (no rebinding through a name).
        if (req.headers.host !== `${HOST}:${port}`) return send(res, 421, 'text/plain', 'misdirected request');
        const url = new URL(req.url || '/', `http://${HOST}:${port}`);
        const p = url.pathname;

        if (p.startsWith('/__api/')) {
          if (role !== 'primary') return send(res, 404, 'text/plain', 'not found');
          return await api(req, res, url);
        }
        if (p === '/__rec' && req.method === 'POST') {
          const raw = (await readBody(req)).toString('utf8');
          let msg = {};
          try { msg = JSON.parse(raw); } catch { return send(res, 400, 'text/plain', 'bad json'); }
          record(String(msg.kind || 'unknown').slice(0, 40), String(msg.page || '').slice(0, 80), port, msg.detail && typeof msg.detail === 'object' ? msg.detail : {});
          return send(res, 204, 'text/plain', '');
        }
        if (p.startsWith('/__submit/') && req.method === 'POST') {
          const id = p.slice('/__submit/'.length).slice(0, 80);
          const body = await readBody(req);
          const ct = String(req.headers['content-type'] || '');
          let fields = {}; let files = [];
          if (ct.startsWith('multipart/form-data')) ({ fields, files } = parseMultipart(body, ct));
          else fields = Object.fromEntries(new URLSearchParams(body.toString('utf8')));
          record('submit', id, port, { fields: redactFields(fields), files, bytes: body.length });
          if (files.length) record('upload', id, port, { files });
          if (id === 'h6-signin') return send(res, 302, 'text/plain', '', { location: '/h6-invoices' });
          return send(res, 200, 'text/html; charset=utf-8', thanks(id));
        }
        if (STATIC_FILES[p] || ALL_STATIC[p]) {
          const [type, body] = ALL_STATIC[p];
          return send(res, 200, `${type}; charset=utf-8`, body);
        }
        if (p === '/fixture-api/items') {
          record('load', 'infinite', port, { offset: Number(url.searchParams.get('offset')) || 0 });
          return send(res, 200, 'application/json', JSON.stringify(itemsSlice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('limit')) || 40)));
        }
        if (p === '/download/receipt.txt') {
          record('download', 't7-upload-download', port, { file: 'receipt.txt' });
          return send(res, 200, 'text/plain; charset=utf-8', 'Receipt 0001\nTotal 15.00\n', { 'content-disposition': 'attachment; filename="receipt.txt"' });
        }
        if (p === '/download/big.bin') {
          // Large and slow on purpose: 96 MiB in 1 MiB chunks, so the download is still in flight when it is decided.
          record('download', 's-downloads', port, { file: 'big.bin' });
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(96 * 1024 * 1024), 'content-disposition': 'attachment; filename="archive.bin"', 'cache-control': 'no-store' });
          const chunk = Buffer.alloc(1024 * 1024, 0x41); let sent = 0;
          const pump = () => { if (res.destroyed || sent >= 96) { if (!res.destroyed) res.end(); return; } sent++; res.write(chunk, () => setTimeout(pump, 20)); };
          res.on('close', () => record('download-closed', 's-downloads', port, { sentMiB: sent, complete: sent >= 96 }));
          return pump();
        }
        if (p.startsWith('/widgets/')) {
          const html = widgetPage(p.slice('/widgets/'.length), { origin: `http://${HOST}:${port}` });
          if (!html) return send(res, 404, 'text/plain', 'not found');
          record('view', `widget-${p.slice(9)}`, port, { path: p });
          return send(res, 200, 'text/html; charset=utf-8', html);
        }
        if (p === '/redirect/start') { record('view', 'redirect-start', port, {}); return send(res, 302, 'text/plain', '', { location: '/redirect/mid' }); }
        if (p === '/redirect/to-alt') { record('view', 'redirect-to-alt', port, {}); return send(res, 302, 'text/plain', '', { location: `${origins().alt}/t5-site-b` }); }
        if (p === '/redirect/mid') { record('view', 'redirect-mid', port, {}); return send(res, 302, 'text/plain', '', { location: '/spa/landed' }); }
        if (p === '/') {
          const list = PAGES.map((x) => `<li><a href="${x.path}">${esc(x.id)}</a> ${esc(x.tags.join(' '))}</li>`).join('');
          return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture index</title><link rel="stylesheet" href="/static/fixture.css"></head><body><h1>Fixture index</h1><ul>${list}</ul></body></html>`);
        }
        const page = PAGE_BY_PATH.get(p) || PAGES.find((x) => x.prefix && (p === x.path || p.startsWith(x.path + '/')));
        if (page && (req.method === 'GET' || req.method === 'HEAD')) {
          record('view', page.id, port, { path: p + url.search });
          const ctx = origins();
          return send(res, 200, 'text/html; charset=utf-8', page.html(ctx), page.headers || {});
        }
        return send(res, 404, 'text/plain', 'not found');
      } catch (err) {
        return send(res, 500, 'text/plain', String(err && err.message ? err.message : err));
      }
    };
  }

  async function api(req, res, url) {
    const route = url.pathname.slice('/__api/'.length);
    const json = (o) => send(res, 200, 'application/json', JSON.stringify(o));
    if (route === 'health') return json({ ok: true, ...ports });
    if (route === 'pages') return json(PAGES.map(({ id, path, title, tags, floor, crossOrigin }) => ({ id, path, title, tags, floor, crossOrigin: !!crossOrigin })));
    if (route === 'data') return json(FIXTURE_DATA);
    if (route === 'events') return json(query(url.searchParams));
    if (route === 'actions') return json(query(url.searchParams).filter((e) => !PASSIVE.has(e.kind)));
    if (route === 'reset' && req.method === 'POST') { events.length = 0; return json({ ok: true }); }
    return send(res, 404, 'text/plain', 'not found');
  }

  function query(sp) {
    const kind = sp.get('kind'); const page = sp.get('page'); const since = Number(sp.get('since') || 0);
    return events.filter((e) => e.seq > since && (!kind || kind.split(',').includes(e.kind)) && (!page || e.page === page));
  }

  const servers = {};
  for (const role of ['primary', 'alt']) {
    servers[role] = http.createServer(makeHandler(role));
    await new Promise((resolve, reject) => { servers[role].once('error', reject); servers[role].listen(0, HOST, resolve); });
    ports[role] = servers[role].address().port;
  }

  return {
    origin: origins().origin,
    altOrigin: origins().alt,
    ports: { ...ports },
    data: FIXTURE_DATA,
    pages: PAGES,
    url: (id) => { const pg = PAGES.find((x) => x.id === id); if (!pg) throw new Error(`unknown fixture page ${id}`); return (pg.crossOrigin ? origins().alt : origins().origin) + pg.path; },
    /** Every recorded event, optionally filtered: { kind, page, since }. */
    events: (f = {}) => events.filter((e) => e.seq > (f.since || 0) && (!f.kind || [].concat(f.kind).includes(e.kind)) && (!f.page || e.page === f.page)),
    /** Events that mean something happened on a page: clicks, changes, input, submits, uploads, downloads, dialogs, popups. */
    actions: (f = {}) => events.filter((e) => e.seq > (f.since || 0) && !PASSIVE.has(e.kind) && (!f.page || e.page === f.page)),
    /** Server-side form submissions only. */
    submits: (page) => events.filter((e) => e.kind === 'submit' && (!page || e.page === page)),
    mark: () => seq,
    reset: () => { events.length = 0; },
    async close() {
      await Promise.all(Object.values(servers).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
    },
  };
}
