import { serviceNoLimits } from './service-no-limits.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Faithful port of BOT-CREATE-OUTSIDE-1019 r3.3 gate.py. One authority decision, in normative guard order.
import type { Row, SetupEntry, WriteReason } from './turn-settle.ts';
export const BOT_MANAGEMENT = new Set(['create_bot', 'update_bot', 'archive_bot', 'restore_bot', 'move_bot', 'set_team_lead']);
export const DESKTOP = new Set(['computer', 'cloud-desktop']);
export const FIXED_SURFACES = new Set(['bulk', 'notification', 'push', 'channel', 'question']);
export const CARD_RENDERERS = new Set(['bot-card@1']);
export const REVIEW_RENDERERS: Record<string, ReadonlySet<string>> = {
  computer: new Set(['bot-review@1']),
  'cloud-desktop': new Set(['bot-review@1']),
  'phone-app': new Set(['bot-review-phone@1']),
};
export const STANDING = new Set(['host_consent', 'folder_trust', 'always_allow']);
export const SETTINGS_GUARD: Record<string, ReadonlySet<string>> = { always_allow: new Set(['computer']), host_consent: new Set(['computer']), folder_trust: DESKTOP };
export type AnswerSurface = 'computer' | 'cloud-desktop' | 'phone-app' | 'cloud-phone' | 'other-owner' | 'bulk' | 'notification' | 'push' | 'channel' | 'question';
export interface Identity { via?: string; app?: string; owners_computer?: boolean; cloud?: boolean; scope?: string }
export interface RenderReceipt { renderer: string; digest: string }
export interface Card { id: string; tool: string; digest: string; eff: string; specDigest: string; gens: Iterable<string>; cut?: boolean }
export interface Pass { card: string; tool: string; digest: string; eff: string; gens: Set<string>; ownerSeen: boolean; surface: string; consumed: boolean }
export function answer_surface(ident: Identity): AnswerSurface {
  const via = ident.via;
  if (via && FIXED_SURFACES.has(via)) return via as AnswerSurface;
  const app = ident.app;
  if (app === 'desktop' && ident.owners_computer && !ident.cloud) return 'computer';
  if (app === 'desktop' && ident.cloud) return 'cloud-desktop';
  if (app === 'phone') return 'phone-app';
  if (ident.cloud && ident.scope === 'owner-phone') return 'cloud-phone';
  return 'other-owner';
}
export function desktop_authority(surface: string | undefined): boolean { return DESKTOP.has(surface!); }
export function owner_seen(card: Card, surface: string, seen: RenderReceipt | null): boolean {
  if (!desktop_authority(surface)) return false;
  if (seen === null) return false;
  if (!CARD_RENDERERS.has(seen.renderer)) return false;
  if (seen.digest !== card.specDigest) return false;
  return true;
}
export function mint(card: Card, surface: string, seen: RenderReceipt | null, behavior: string): Pass | null {
  if (behavior !== 'allow') return null;
  if (surface === 'question') return null;
  if (card.cut) return null;
  return { card: card.id, tool: card.tool, digest: card.digest, eff: card.eff, gens: new Set(card.gens),
    ownerSeen: owner_seen(card, surface, seen), surface, consumed: false };
}
export function automatic_answer(_card: Card): Pass | null { return null; }
export function match_pass(passes: Pass[], gen: string, tool: string, digest: string): Pass | null {
  for (const p of passes) {
    if (p.consumed || !p.gens.has(gen) || p.tool !== tool) continue;
    if (p.digest !== digest) continue;
    p.consumed = true; // synchronously, before any await
    return p;
  }
  return null;
}
export function commit_reason(origin: string, live_read: string | null, row: Row | null, driver_ok: boolean): WriteReason {
  if (origin === 'content') return 'content';
  if (live_read !== null) return 'outside';
  if (!driver_ok) return 'unsettled';
  if (row === null) return 'unsettled';
  if (row.settled) return 'unsettled';
  if (row.abnormal) return 'unsettled';
  if (row.marked) return 'outside';
  return 'turn-open';
}
export type Action =
  | { kind: 'bot'; tool: string; gen: string; digest: string; eff: string }
  | { kind: 'review'; action: string }
  | { kind: 'grant'; sink: string; route: string }
  | { kind: 'setup_at_settle'; entry: SetupEntry }
  | { kind: 'tool'; tool: string };
export interface Context {
  authz?: string; passes?: Pass[]; origin?: string; live_read?: string | null; row?: Row | null; driver_ok?: boolean;
  surface?: string; seen?: RenderReceipt | null; live_digest?: string; settle_ok?: boolean; verdict?: string; option_now?: boolean; card_open?: boolean;
}
export function decide(action: Action, ctx: Context): [string, string | null] {
  const kind = action.kind;
  if (kind === 'bot') {
    const { tool, gen } = action;
    if (ctx.authz) return ['refuse', ctx.authz];
    if (serviceNoLimits(gen, ctx.row?.thread)) return ['active', null];
    const p = match_pass(ctx.passes!, gen, tool, action.digest);
    const origin = ctx.origin!;
    if (origin === 'content' && p === null) {
      const minted = ctx.passes!.some(q => q.tool === tool && q.gens.has(gen));
      return ['refuse', minted ? 'C11' : 'C5'];
    }
    if (tool === 'archive_bot') return ['run', null];
    if (p !== null && p.ownerSeen && p.eff === action.eff) return ['active', null];
    return ['staged', commit_reason(origin, ctx.live_read!, ctx.row!, ctx.driver_ok!)];
  }
  if (kind === 'review') {
    if (action.action === 'discard') return ['discarded', null];
    const surface = ctx.surface!, seen = ctx.seen ?? null;
    if (!(surface in REVIEW_RENDERERS)) return ['403', 'C13'];
    if (seen === null || !REVIEW_RENDERERS[surface].has(seen.renderer)) return ['409', 'changed'];
    if (seen.digest !== ctx.live_digest) return ['409', 'changed'];
    return ['activated', null];
  }
  if (kind === 'grant') {
    const { sink, route } = action, surface = ctx.surface;
    if (route === 'engine') return ['no-write', null];
    if (route === 'settle') return ctx.settle_ok ? ['write', null] : ['no-write', null];
    if (route === 'owner_settings') {
      const allowed = SETTINGS_GUARD[sink];
      if (allowed !== undefined && !allowed.has(surface!)) return ['no-write', null];
      return ['write', null];
    }
    if (route === 'owner_answer') {
      if (STANDING.has(sink) && !desktop_authority(surface)) return ['once', null];
      return ['write', null];
    }
    throw new Error('unclassified grant route: ' + route);
  }
  if (kind === 'setup_at_settle') {
    const e = action.entry;
    const resolve = ctx.verdict === 'clean' && e.option && ctx.option_now && ctx.card_open;
    if (resolve) return ['resolve', null];
    return ['keep', e.push_suppressed && ctx.card_open ? 'push' : null];
  }
  if (kind === 'tool') {
    if (action.tool === 'allow_for_task') return ['confirm-on-card', null];
    if (action.tool === 'phone') return ['run', null];
    return ['run', null];
  }
  return ['refuse', 'unknown'];
}
