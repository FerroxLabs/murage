import { createHash } from 'node:crypto';
import { BOT_MANAGEMENT, mint, type Pass, type RenderReceipt } from './outside-authority.ts';
import type { Store, OptionCardData } from './store.ts';
import type { Origin } from './turn-settle.ts';
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])])) : v;
export const botDigest = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export function botToolName(tool: string): string | undefined {
  const name = tool.split(/__|[.:/]/).at(-1)!; return BOT_MANAGEMENT.has(name) ? name : undefined;
}
export function botCallDigest(tool: string, raw: Record<string, any>): string {
  const input: Record<string, any> = { ...raw, ...(raw.model_selection !== undefined ? { modelSelection: raw.model_selection } : {}), ...(raw.organization_revision !== undefined ? { organizationRevision: raw.organization_revision } : {}) };
  const fields = tool === 'create_bot' ? ['name', 'role', 'instructions', 'section', 'lead', 'modelSelection'] : ['revision', 'organizationRevision', 'name', 'role', 'instructions', 'section', 'modelSelection'];
  const body = Object.fromEntries(fields.filter(k => input[k] !== undefined).map(k => [k, input[k]]));
  if (tool !== 'create_bot') body.target = input.targetBotId ?? input.bot_id ?? input.botId;
  return botDigest({ tool, body });
}
export interface BotCardAuthority {
  asking: { generation: string; origin: Origin; rootGeneration: string; rootBotId: string };
  tool: string; digest: string; effectiveDigest: string; specDigest: string; spec: Record<string, unknown>; effective: unknown; cut: boolean;
  pass?: Omit<Pass, 'gens'> & { gens: string[] };
}
export class BotCallAuthority {
  private store: Store;
  constructor(store: Store) { this.store = store; }
  card(generation: string, origin: Origin, botId: string, toolName: string, input: unknown, cut: boolean, effective: unknown): BotCardAuthority | undefined {
    const tool = botToolName(toolName); if (!tool || !input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const spec = canonical(input), digest = botCallDigest(tool, spec), effectiveDigest = botDigest(effective);
    return { asking: { generation, origin, rootGeneration: generation, rootBotId: botId }, tool, digest, effectiveDigest, specDigest: botDigest({ spec, effective }), spec, effective, cut };
  }
  answer(thread: string, requestId: string, behavior: string, surface: string, seen?: RenderReceipt) {
    const message = this.store.cardForRequest(thread, requestId, m => !!m.card?.botAuthority);
    const a = message?.card?.botAuthority; if (!message?.card || !a || a.pass || message.card.answered || message.card.dismissed) return;
    const pass = mint({ id: message.id, tool: a.tool, digest: a.digest, eff: a.effectiveDigest, specDigest: a.specDigest, gens: [a.asking.generation], cut: a.cut }, surface, seen ?? null, behavior);
    if (pass) this.store.patchMessage(thread, message.id, { card: { ...message.card, botAuthority: { ...a, pass: { ...pass, gens: [...pass.gens] } } } });
  }
  continue(thread: string, cardId: string, generation: string): Origin {
    const message = this.store.messageById(thread, cardId), a = message?.card?.botAuthority;
    if (!a || !message?.card) return 'content';
    if (a.pass && !a.pass.consumed && !a.pass.gens.includes(generation)) this.store.patchMessage(thread, cardId, { card: { ...message.card, botAuthority: { ...a, pass: { ...a.pass, gens: [...a.pass.gens, generation] } } } });
    return a.asking.origin === 'own' || a.asking.origin === 'reached' ? 'reached' : 'content';
  }
  passes(thread: string, generation: string): { passes: Pass[]; persist: () => void } {
    const entries: Array<{ id: string; card: OptionCardData; pass: Pass }> = [];
    this.store.scanNewest(thread, m => {
      const a = m.card?.botAuthority, p = a?.pass;
      if (m.card && p?.gens.includes(generation)) entries.push({ id: m.id, card: m.card, pass: { ...p, gens: new Set(p.gens) } });
      return entries.length >= 64;
    });
    return { passes: entries.map(e => e.pass), persist: () => {
      for (const e of entries) if (e.pass.consumed !== e.card.botAuthority!.pass!.consumed) this.store.patchMessage(thread, e.id, { card: { ...e.card, botAuthority: { ...e.card.botAuthority!, pass: { ...e.pass, gens: [...e.pass.gens] } } } });
    } };
  }
}
