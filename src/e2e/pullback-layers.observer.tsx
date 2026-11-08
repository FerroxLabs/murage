// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement as h, useLayoutEffect, useState, type ReactNode } from 'react';
import { useStore, useStreaming, type Action, type AppState } from '../state/store';
import { focusableWithin, openLayers, trapFocus } from '../lib/focus-trap';
import type { NativeCase } from './pullback-layers.native';
import { OPEN_PALETTE_EVENT } from '../lib/app-events';

export interface LayerSnapshot { id: string; name: string; kind: string; sequence: number; rank: number | null; paintRank: number | null; focused: boolean }
export interface PullbackProbe {
  state: AppState;
  streaming: ReturnType<typeof useStreaming>;
  dispatch: (action: Action) => void;
  layers: () => LayerSnapshot[];
  hit: (name: string) => boolean;
  reachable: (id: string) => string[];
  /** A production focus trap on the element with this id (one at a time), released by untrap. */
  trap: (id: string) => void;
  untrap: () => void;
  palette: () => void;
  auxiliary: (name: 'editor' | 'memory' | 'shortcuts' | 'bots' | 'channels' | 'hire' | 'phone-sheet' | 'approval-sheet' | 'none') => Promise<void>;
  nativeCase: (name: NativeCase, warm: boolean, strict: boolean) => Promise<void>;
  call: (id?: string) => Promise<string | null>;
  beginSend: () => Promise<string>;
  lookup: () => Promise<string>;
  mark: () => void;
  sameFocus: () => boolean;
}
declare global {
  interface Window { pullbackWorkspace: (kind: 'browser' | 'vm') => void; pullbackReloads?: number; pullback: PullbackProbe; pullbackMount: () => void; pullbackUnmount: () => void; }
}
let focus: Element | null = null;
let untrap: (() => void) | null = null;
export function PullbackObserver() {
  const { state, dispatch } = useStore();
  const streaming = useStreaming();
  const [aux, setAux] = useState<ReactNode>(null);
  const [native, setNative] = useState<ReactNode>(null);
  useLayoutEffect(() => {
    window.pullback = { state, dispatch, streaming,
      layers: () => openLayers().map(entry => {
        const surface = (entry.container as HTMLElement | null)?.closest('[data-layer-surface]');
        return { id: entry.id, name: entry.name, kind: entry.kind, sequence: entry.sequence, rank: entry.zIndex,
          paintRank: surface ? Number(getComputedStyle(surface).zIndex) : null, focused: !!entry.container?.contains(document.activeElement) };
      }),
      reachable: id => focusableWithin(document.getElementById(id)!).map(node => (node as HTMLElement).id),
      trap: id => { const held = trapFocus(document.getElementById(id)!, { returnFocusTo: null }); untrap = () => held.release(); },
      untrap: () => { untrap?.(); untrap = null; },
      hit: name => {
        const node = openLayers().find(entry => entry.name === name)?.container as HTMLElement;
        if (!node) return false;
        const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      },
      palette: () => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT)),
      auxiliary: async name => {
        const close = () => setAux(null);
        if (name === 'none') { setAux(null); setNative(null); }
        if (name === 'phone-sheet') { const { PhoneSheet } = await import('../components/phone/PhoneSheet'); setAux(h(PhoneSheet, { title: 'Fixture sheet', onClose: close, children: h('button', null, 'Fixture action') })); }
        if (name === 'approval-sheet') { const { ApprovalDetailsSheet } = await import('../components/PendingApproval'); setAux(h(ApprovalDetailsSheet, { bot: 'Pullback bot', pending: { message: { id: 'fixture-approval', role: 'bot', kind: 'text', text: 'Fixture approval', at: 1 }, requestId: 'fixture-request', tool: 'Read', detail: 'Fixture file' }, foot: h('button', null, 'Fixture answer'), onClose: close })); }
        if (name === 'hire') { const { HireBotDialog } = await import('../components/hire/HireBotDialog'); setAux(h(HireBotDialog, { onClose: close, returnFocusTo: document.activeElement as HTMLElement })); }
        if (name === 'editor') { const { SectionContextDialog } = await import('../components/SectionContextDialog'); setAux(h(SectionContextDialog, { section: 'fixture', label: 'Fixture team', onClose: close })); }
        if (name === 'memory') { const { MemoryLauncher } = await import('../components/MemoryLauncher'); setAux(h(MemoryLauncher, { botId: 'pullback-bot', botName: 'Pullback bot' })); }
        if (name === 'shortcuts') { const { KeyboardShortcutsDialog } = await import('../components/KeyboardShortcutsDialog'); setNative(h(KeyboardShortcutsDialog, { open: true, onClose: () => setNative(null) })); }
        if (name === 'bots') { const { ArchivedBotsPanel } = await import('../components/Sidebar'); setAux(h(ArchivedBotsPanel, { bots: [{ ...state.bots[0], hidden: true }], groups: [], onClose: close, onRestored: () => {}, onDeleted: () => {} })); }
        if (name === 'channels') { const { ArchivedChannelsPanel } = await import('../components/Sidebar'); setAux(h(ArchivedChannelsPanel, { groups: [{ id: 'archived-channel', name: 'Fixture channel', memberIds: [], messages: [], section: '', createdAt: 1, threadId: 'archived-thread', defaultResponder: { kind: 'mentions' }, bulletin: '', unread: false }], onClose: close, onRestored: () => {} })); }
      },
      nativeCase: async (name, warm, strict) => {
        const { NativeFixture, loadNative } = await import('./pullback-layers.native');
        const loaded = warm ? await loadNative(name) : undefined;
        setAux(h(NativeFixture, { name, loaded, strict, onClose: () => setAux(null) }));
      },
      call: async id => { const call = await import('../lib/call'); if (id) call.startCall(id); return call.currentCall(); },
      beginSend: async () => {
        const drafts = await import('../lib/drafts');
        const id = 'bot:pullback-bot:pullback-thread';
        drafts.setComposerDraftText(id, 'Fixture turn'); await drafts.persistDraft(id);
        const result = await drafts.beginDraftSend(id, { text: 'Fixture turn', att: [], mode: 'chat' }, (sendId, content) => ({ sendId, kind: 'bot', botId: 'pullback-bot', threadId: 'pullback-thread', text: content.text, at: Date.now(), attempts: 0 }));
        if (!result.ok) throw Error(`Fixture send refused: ${result.reason}`);
        dispatch({ type: 'send', botId: 'pullback-bot', threadId: 'pullback-thread', text: result.content.text, sendId: result.sendId, outboxDraft: { draftId: id, attemptId: result.attemptId, text: result.content.text, requestText: result.content.text, attachments: [] } });
        sessionStorage.setItem('pullback-send', result.sendId);
        return result.sendId;
      },
      lookup: async () => (await import('../lib/drafts')).checkDraftPin('bot:pullback-bot:pullback-thread', sessionStorage.getItem('pullback-send')!),
      mark: () => { focus = document.activeElement; }, sameFocus: () => focus === document.activeElement,
    };
  });
  return h('div', { 'data-pullback-auxiliary': '' }, aux, native);
}
