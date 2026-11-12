import type { Origin } from './turn-settle.ts';
export interface TurnAncestry { rootGeneration: string; rootBotId: string; rootOwn: true; hops: number; kind: string }
export interface OriginFacts {
  botId: string; generation: string; ownerStarted: boolean; storedOrigin?: string;
  unattended?: boolean; routine?: boolean; appChild?: boolean; openClaw?: boolean;
  hops: readonly string[]; ancestry?: TurnAncestry;
}
/** Only positive server-owned admission facts can establish an owner root. */
export function turnOrigin(f: OriginFacts): Origin {
  if (f.unattended || f.routine || f.appChild || f.openClaw) return 'content';
  if (f.hops.length) return f.hops.length === 1 && f.ancestry?.rootOwn === true ? 'reached' : 'content';
  return f.ownerStarted && f.storedOrigin === 'owner' ? 'own' : 'content';
}
