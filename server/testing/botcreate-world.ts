// Port of the r3.3.1 world.py harness. Expectations are read directly, never translated.
import { readFileSync } from 'node:fs';
import type * as Settle from '../turn-settle.ts';
import type * as Gate from '../outside-authority.ts';
type Args = Record<string, any>;
export interface Trace { id: string; inv: string; kind: string; guard: string; steps: string; expect: string }
const lines = readFileSync(new URL('./botcreate-spec/traces.tsv', import.meta.url), 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
const headers = lines.shift()!.split('\t');
export const traces = lines.map(l => Object.fromEntries(l.split('\t').map((v, i) => [headers[i], v])) as unknown as Trace);
const IDENT: Record<string, Args> = {
  'desktop-local': { app: 'desktop', owners_computer: true }, 'cloud-desktop': { app: 'desktop', cloud: true },
  'phone-app': { app: 'phone' }, 'cloud-phone': { cloud: true, scope: 'owner-phone' },
  passkey: { cloud: true, scope: 'owner-browser' }, bulk: { via: 'bulk', app: 'desktop', owners_computer: true },
  notification: { via: 'notification' }, push: { via: 'push' }, channel: { via: 'channel' },
  question: { via: 'question', app: 'desktop', owners_computer: true },
};
const val = (v: string) => v === 'null' ? null : /^-?\d+$/.test(v) ? Number(v) : v;
export class World {
  L: Settle.Ledger;
  rows = new Set<string>();
  cards: Record<string, any> = {}; passes: Gate.Pass[] = []; bots: Record<string, any> = {}; setups: Record<string, any> = {};
  last: any = null; grant: any = null; review: any = null; ev: any = null;
  live_origin: Record<string, string> = {}; option = true;
  public S: typeof Settle;
  public G: typeof Gate;
  constructor(S: typeof Settle, G: typeof Gate) { this.S = S; this.G = G; this.L = new S.Ledger(); }
  row(gen: string) { return this.L.rows.get(gen); }
  bot(b: string): any { return this.bots[b] ??= { state: 'absent', reason: null, rev: 0, held: [], ran: 0, spec: null, pending: null }; }
  digest_live(b: string) { const x = this.bot(b); return `D:${b}:${x.spec}:${x.pending}:${x.rev}`; }
  activate(b: string) {
    const x = this.bot(b);
    if (x.state === 'staged') { x.state = 'active'; x.reason = null; }
    else if (x.pending !== null) { x.spec = x.pending; x.pending = null; x.reason = null; }
    x.ran += x.held.length; x.held = [];
  }
  settle_gen(gen: string, ev: Settle.TerminalEvent) {
    const r = this.L.take(gen); if (!r) return;
    const v = this.S.settle_verdict(r, ev, this.L.live.get(r.thread) ?? null, this.live_origin[r.thread] ?? 'own');
    for (const [b, rev] of r.writes) {
      const out = this.S.write_outcome(v, rev, this.bot(b).rev);
      if (out === 'active') this.activate(b); else this.bot(b).reason = out;
    }
    for (const e of r.setup) {
      const st = this.setups[e.req];
      const [verdict, detail] = this.G.decide({ kind: 'setup_at_settle', entry: e }, { verdict: v, option_now: this.option, card_open: st.state === 'open' });
      if (verdict === 'resolve') st.state = 'enabled'; else if (detail === 'push') st.push = 1;
    }
  }
  op(name: string, a: Args) {
    const r = this.row(a.g);
    switch (name) {
      case 'cfg': this.rows = new Set(String(a.rows ?? '').split(',').filter(Boolean)); if ('option' in a) this.option = !!a.option; break;
      case 'cwd': if (this.S.cwd_marks(a.holds ?? 0, a.inside ?? 0)) this.L.mark(a.t, 'cloned folder'); break;
      case 'admit': this.L.open(a.g, a.t ?? 'T', a.d, a.o ?? 'own'); this.live_origin[a.t ?? 'T'] ??= a.o ?? 'own'; break;
      case 'bind': this.L.bind(a.g, a.p); break;
      case 'item':
        if (a.throw) this.L.abnormal(undefined, a.g);
        if (a.pending) r!.unclassified++;
        if (a.read) this.L.mark(r!.thread, a.src ?? 'web'); break;
      case 'mark': this.L.mark(a.t ?? 'T', a.src ?? 'web'); break;
      case 'hmark': this.L.helper_mark(a.g); break;
      case 'helper':
        if (!['spawned', 'progress', 'finished'].includes(a.event ?? 'spawned')) throw new Error('unknown helper lifecycle event');
        this.L.mark(r!.thread, 'helper', true); break;
      case 'reset': this.L.live.set(a.t ?? 'T', null); break;
      case 'taint': this.L.live.set(a.t ?? 'T', a.src ?? 'session'); break;
      case 'drift': this.live_origin[a.t ?? 'T'] = a.o; break;
      case 'error': this.L.abnormal(a.t ?? 'T'); break;
      case 'card': {
        const digest = `${a.tool}|${a.bot}|${a.spec ?? '-'}`;
        this.cards[a.c] = { id: a.c, tool: a.tool, digest, eff: a.eff ?? 'e1', specDigest: `SD:${digest}:${a.eff ?? 'e1'}`,
          cut: !!a.cut, gens: [a.g], asking: r?.origin ?? 'content', thread: r?.thread ?? 'T', driver: r?.driver ?? 'fuigo' }; break;
      }
      case 'answer': {
        const card = this.cards[a.c], ident = { ...IDENT[a.who] };
        if ('body_surface' in a) ident.body = { surface: a.body_surface };
        const seen = a.seen != null ? { renderer: a.renderer ?? 'bot-card@1', digest: a.seen === 'match' ? card.specDigest : 'SD:stale' } : null;
        const p = this.G.mint(card, this.G.answer_surface(ident), seen, a.behavior ?? 'allow');
        card.pass = p; if (p) this.passes.push(p); break;
      }
      case 'autoallow': { const p = this.G.automatic_answer(this.cards[a.c]); if (p) this.passes.push(p); break; }
      case 'cont': {
        const card = this.cards[a.c]; this.L.open(a.g, card.thread, card.driver, ['own', 'reached'].includes(card.asking) ? 'reached' : 'content');
        card.gens.push(a.g); card.pass?.gens.add(a.g); break;
      }
      case 'restart': for (const x of Object.values(this.bots)) if (x.reason === 'turn-open') x.reason = 'unsettled'; this.L = new this.S.Ledger(); break;
      case 'call': {
        const origin = r?.origin ?? a.o ?? 'content', thread = r?.thread ?? a.t ?? 'T', driver = r?.driver ?? a.d ?? 'fuigo';
        const [verdict, detail] = this.G.decide({ kind: 'bot', tool: a.tool, gen: a.g, digest: `${a.tool}|${a.bot}|${a.spec ?? '-'}`, eff: a.eff ?? 'e1' },
          { authz: a.authz, passes: this.passes, origin, live_read: this.L.live.get(thread) ?? null, row: r ?? null, driver_ok: this.S.SETTLE_EVIDENCE_DRIVERS.has(driver) });
        this.last = verdict + (detail ? ':' + detail : ''); const x = this.bot(a.bot);
        if (a.tool === 'create_bot') {
          if (verdict === 'active') Object.assign(x, { state: 'active', spec: a.spec ?? null, reason: null });
          else if (verdict === 'staged') Object.assign(x, { state: 'staged', spec: a.spec ?? null, reason: detail });
        } else if (a.tool === 'archive_bot') { if (verdict === 'run') x.state = 'archived'; }
        else if (verdict === 'active') x.spec = a.spec ?? null;
        else if (verdict === 'staged') { x.pending = a.spec ?? null; x.reason = detail; }
        if (verdict === 'staged' && detail === 'turn-open') r!.writes.push([a.bot, x.rev]); break;
      }
      case 'bot': Object.assign(this.bot(a.bot), { state: 'active', spec: a.spec ?? 's0' }); break;
      case 'delivered': this.L.mark(a.t ?? 'T', 'another bot'); break;
      case 'ask':
      case 'delegate': { const x = this.bot(a.to); if (x.state === 'staged') x.held.push(a.text ?? 'work'); else x.ran++; break; }
      case 'edit': this.bot(a.bot).rev++; break;
      case 'term': {
        const gen = this.L.gen_of(a.p, a.t ?? 'T')!, engine = a.e ?? this.row(gen)?.driver ?? 'fuigo';
        this.ev = this.S.emit(engine, a, this.S.complete_flag(engine, a, this.rows));
        const fam = this.S.FAMILY[engine] as keyof typeof this.S.HELPER_ROW;
        const held = fam === 'acp' && a.site === 'settle_held'
          || fam === 'codex' && (a.site === 'held_done' || a.helpers_ever_held)
          || fam === 'claude' && a.bg_ever_held;
        if (this.row(gen) && held) {
          this.op('helper', { g: gen, event: 'finished' });
          const recorded = this.rows.has(this.S.HELPER_ROW[fam]);
          this.ev.helperRow = { name: this.S.HELPER_ROW[fam], site: a.site, recorded,
            readsComplete: recorded && !!(a.helper_reads_complete ?? 1), outsideRead: !!a.helper_outside_read,
            interrupted: ['asked', 'stop_requested', 'cancel_requested', 'steer_ever_waited', 'interj_accepted', 'interj_pending', 'interj_uncertain'].some(k => !!a[k]) };
        }
        this.settle_gen(gen, this.ev); break;
      }
      case 'emit': this.ev = this.S.emit(a.e, a, this.S.complete_flag(a.e, a, this.rows)); break;
      case 'release': this.L.abnormal(undefined, a.g); this.settle_gen(a.g, { ok: false }); break;
      case 'review': {
        const seen = a.seen != null ? { renderer: a.renderer ?? 'bot-review@1', digest: a.seen === 'live' ? this.digest_live(a.bot) : 'D:stale' } : null;
        const [v] = this.G.decide({ kind: 'review', action: a.action ?? 'activate' }, { surface: this.G.answer_surface(IDENT[a.who]), seen, live_digest: this.digest_live(a.bot) });
        this.review = v;
        if (v === 'activated') this.activate(a.bot); else if (v === 'discarded') Object.assign(this.bot(a.bot), { state: 'absent', pending: null }); break;
      }
      case 'setup': {
        const recorded = r && !r.settled;
        this.setups[a.req] = { state: 'open', push: this.option && recorded ? 0 : 1 };
        this.G.decide({ kind: 'grant', sink: 'routine_apply', route: 'engine' }, {});
        if (recorded) r.setup.push({ req: a.req, origin: r.origin, option: this.option, push_suppressed: this.option }); break;
      }
      case 'option': this.option = !!a.v; break;
      case 'answer_setup': if (this.setups[a.req].state === 'open') this.setups[a.req].state = 'enabled-by-owner'; break;
      case 'grant': [this.grant] = this.G.decide({ kind: 'grant', sink: a.sink, route: a.route }, { surface: this.G.answer_surface(IDENT[a.who ?? 'desktop-local'] ?? {}), settle_ok: !!a.settle_ok }); break;
      case 'tool': [this.last] = this.G.decide({ kind: 'tool', tool: a.tool }, {}); break;
      default: throw new Error(`Unimplemented trace op: ${name}`);
    }
  }
  observe(key: string): string {
    if (key === 'last') return this.last;
    if (key === 'grant') return this.grant;
    if (key === 'review') return this.review;
    if (key.startsWith('ev.')) { const f = key.slice(3), v = f === 'readsComplete' ? Number(this.ev[f] === true) : (f in this.ev ? this.ev[f] : 'absent'); return v === null ? 'null' : String(v); }
    const [kind, name] = key.split(':'); const x = this.bot(name);
    switch (kind) {
      case 'bot': return x.state === 'staged' ? `staged:${x.reason}` : x.pending !== null ? `pending:${x.reason}` : x.state;
      case 'spec': return String(x.spec); case 'ran': return String(x.ran);
      case 'setup': return this.setups[name].state; case 'push': return String(this.setups[name].push);
      case 'pass': { const p = this.cards[name].pass; return p == null ? 'none' : p.ownerSeen ? 'seen' : 'unseen'; }
      default: throw new Error(`Unimplemented observation: ${key}`);
    }
  }
  run(trace: Trace): string[] {
    try {
      for (const step of trace.steps.split(';').map(s => s.trim()).filter(Boolean)) {
        const [name, ...args] = step.split(/\s+/);
        this.op(name, Object.fromEntries(args.map(t => { const i = t.indexOf('='); return [t.slice(0, i), val(t.slice(i + 1))]; })));
      }
      return trace.expect.split(/\s+/).flatMap(e => { const i = e.lastIndexOf('='), key = e.slice(0, i), want = e.slice(i + 1), got = this.observe(key); return got === want ? [] : [`${key} want=${want} got=${got}`]; });
    } catch (e) { return [`crash ${e}`]; }
  }
}
