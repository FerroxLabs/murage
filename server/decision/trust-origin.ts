// Producer: TRUST-V2-a / MAIN decision lane; consumers: TRUST-V2-a/-c and WIN-GIT-BASH B4.
import { initiatorKindFor, readTurnPolicy } from './implementation.ts';
import type { Registration } from './types.ts';

export type TrustOrigin = {
  kind: 'owner-direct' | 'owner-routine-manual' | 'owner-routine-scheduled' | 'ineligible';
  level: Registration['level'];
  noLimits: boolean;
  authorityGeneration: string;
  threadId: string;
  botId: string;
};

export function trustOriginNow(q: { threadId: string; generation: string; botId: string }): TrustOrigin {
  const fallback: TrustOrigin = { kind: 'ineligible', level: 'ask', noLimits: false,
    authorityGeneration: q.generation, threadId: q.threadId, botId: q.botId };
  try {
    const p = initiatorKindFor(q.generation);
    if (!p || p.generation !== q.generation || p.threadId !== q.threadId || p.botId !== q.botId) return fallback;
    const policy = readTurnPolicy(q);
    if (!policy) return fallback;
    const i = p.initiator;
    let kind: TrustOrigin['kind'] = 'ineligible';
    if (policy.actor === 'owner' && (i.k === 'owner-typed' || i.k === 'owner-channel-dm')) kind = 'owner-direct';
    else if (policy.actor === 'owner-routine' && (i.k === 'routine-run' || i.k === 'routine-wake')) {
      if (i.trigger === 'manual') kind = 'owner-routine-manual';
      else if (i.trigger === 'schedule') kind = 'owner-routine-scheduled';
    }
    return { ...fallback, kind, level: policy.level, noLimits: kind !== 'ineligible' && policy.permission.noLimits === true };
  } catch { return fallback; }
}
