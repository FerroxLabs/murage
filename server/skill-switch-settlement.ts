// Owner ingress/token/executor owner: skills lane. Transport/attempt owner: decision lane.
import { createHash } from 'node:crypto';
import type { PendingQueueApproval } from './decision/types.ts';

declare const ownerSettlementBrand: unique symbol;
export type OwnerSettlementToken = { readonly [ownerSettlementBrand]: true };
export type AutomaticCause = 'no-limits' | 'level-upgrade' | 'full-access-settle' | 'recovery' | 'replay' | 'unspecified';
export type Settlement = { readonly kind: 'owner'; readonly token: OwnerSettlementToken }
  | { readonly kind: 'automatic'; readonly cause: AutomaticCause };
export const automaticSettlement = (cause: AutomaticCause = 'unspecified'): Settlement => ({ kind: 'automatic', cause });
export const ownerSkillPosture = (noLimits:boolean,attended:boolean|undefined,why:'base'|'deny'|'wipe'|'question'):boolean =>
  !noLimits || attended===false || why==='deny' || why==='wipe';
export type InvocationKind = 'single-card' | 'preview' | 'bulk' | 'bulk-fallback' | 'level-upgrade';
export interface OwnerSession {
  readonly reference: object;
  readonly principal: string;
  readonly epoch: string;
  readonly live: () => boolean;
}
export interface OwnerResponseContext {
  readonly kind: InvocationKind;
  readonly authorized: boolean;
  readonly affirmative: boolean;
  readonly freshAuth: 'satisfied' | 'not-required' | 'failed' | 'missing';
  readonly session?: OwnerSession;
  readonly invocation: object;
  readonly invocationLive: () => boolean;
  readonly cardLive: () => boolean;
  readonly reviewedPreview: string | undefined;
  readonly reviewedVerdict: string | undefined;
  readonly currentPreview: string;
  readonly currentVerdict: string;
}
export interface EffectAuthorization { readonly kind: 'owner' | 'automatic'; readonly cause?: AutomaticCause; readonly principal?: string }
/** Server-only argument. No member is copied into a wire answer or a queue record. */
export interface SkillDeliveryContext {
  readonly item: PendingQueueApproval;
  readonly settlement: Settlement;
  readonly beginEffect: (authorization: EffectAuthorization) => void;
}
export class SkillSwitchRefused extends Error {
  readonly code: 'needs-review' | 'changed' | 'unauthorized' | 'storage' | 'limit-exceeded';
  constructor(code: SkillSwitchRefused['code'], message: string) { super(message); this.code=code; }
}
export const UNCONFIRMED_SKILL_SWITCH = 'The result of this skill change could not be confirmed. Check Skills before making a new request.';

const itemBinding = (item: PendingQueueApproval): string => createHash('sha256').update(JSON.stringify([
  item.kind, item.ref, item.epoch, item.approvalId, item.call,
])).digest('hex');

/** A server constructs one registry and gives only its authenticated adapter the issuer closure.
 * Another registry cannot issue capabilities accepted by this executor. No global mint API. */
export function createOwnerSettlementRegistry(observer?: (event: { kind: InvocationKind }) => void) {
  type Binding = { item: string; context: OwnerResponseContext; behavior: 'allow'; used: boolean };
  const registry = new WeakMap<OwnerSettlementToken, Binding>();
  const eligible = (c: OwnerResponseContext) => c.authorized && c.kind === 'single-card' && c.affirmative
    && (c.freshAuth === 'satisfied' || c.freshAuth === 'not-required')
    && !!c.session && c.session.live() && c.invocationLive() && c.cardLive();
  const valid = (token: OwnerSettlementToken, item: PendingQueueApproval): Binding | undefined => {
    const b = token && typeof token === 'object' ? registry.get(token) : undefined;
    return b && !b.used && b.item === itemBinding(item) && eligible(b.context) ? b : undefined;
  };
  return {
    issue(item: PendingQueueApproval, context: OwnerResponseContext): OwnerSettlementToken | undefined {
      const input = item.call.input as { previewSha256?: string; verdictHash?: string };
      if (!eligible(context) || !input.previewSha256 || !input.verdictHash
        || context.reviewedPreview !== input.previewSha256 || context.currentPreview !== input.previewSha256
        || context.reviewedVerdict !== input.verdictHash || context.currentVerdict !== input.verdictHash) return;
      const token = Object.freeze({}) as OwnerSettlementToken;
      registry.set(token, { item: itemBinding(item), context:Object.freeze({...context,session:context.session?Object.freeze({...context.session}):undefined}), behavior:'allow', used: false });
      observer?.({ kind: context.kind });
      return token;
    },
    validate(token: OwnerSettlementToken, item: PendingQueueApproval): boolean { return !!valid(token, item); },
    consume(token: OwnerSettlementToken, item: PendingQueueApproval): string | undefined {
      const b = valid(token, item);
      if (!b) return;
      b.used = true;
      return b.context.session!.principal;
    },
    expire(token: OwnerSettlementToken): void { registry.delete(token); },
  };
}
