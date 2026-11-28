// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Astra 1fbb27906d High: Try again on a CHECKING card re-sends that change's own request. A view redrawn after Settings changed
// elsewhere must not lend its newer expect to the retry, or the retry would overwrite the intervening change.
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../../testing/dom-harness';
import type { SettingCardRecord } from '../../../shared/settings-chat';
import type { CardView } from '../../lib/settings-chat';
import { CHAT_CONTROLS, SettingCard, type ChatControlProps } from './SettingCard';

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => { delete CHAT_CONTROLS.FixtureModelControl; restore(); });
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); });

CHAT_CONTROLS.FixtureModelControl = ({ disabled, onChange }: ChatControlProps) =>
  h('button', { type: 'button', 'data-pick': 'model-c', disabled, onClick: () => onChange('model-c') }, 'Pick model-c');
const card: SettingCardRecord = { cardId: 'card-1', threadId: 'th-fixture', botId: 'fixture-bot', generation: 'gen-1', settingId: 'bot.model',
  settingBot: 'fixture-bot', writerTarget: { kind: 'bot' }, cardGen: 1, state: 'OPEN', reason: 'cheaper', createdAt: 1 };
const view = (over: Partial<CardView> = {}): CardView => ({ card, label: 'Model', path: 'Settings > Bots > Model', scopeLine: "Fixture's model",
  control: 'inline', chatControl: 'FixtureModelControl', value: 'model-a', expect: 'model-a', busy: false, ...over });
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!;

describe('SettingCard Try again', () => {
  it('re-sends the CHECKING change with its own expect, value, cardGen and changeId after the view redraws', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let answer = { status: 503, body: { ok: false, code: 'COULD_NOT_CHECK' } as Record<string, unknown> };
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as Record<string, unknown>);
      return { status: answer.status, json: async () => answer.body };
    }) as unknown as typeof fetch;
    const props = { botName: 'Fixture', openAddress: () => {}, fetchImpl };
    const app = mount(h(SettingCard, { view: view(), ...props }));
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-pick]')!.click(); });
    await settle();
    expect(button('Try again')).toBeTruthy();
    const first = sent[0]!;
    expect(first).toMatchObject({ value: 'model-c', expect: 'model-a', cardGen: 1 });
    // Settings changed elsewhere; the card view redraws with the live value before the owner taps Try again
    app.rerender(h(SettingCard, { view: view({ value: 'model-b', expect: 'model-b' }), ...props }));
    answer = { status: 409, body: { ok: false, code: 'VALUE_CHANGED', live: 'model-b', card } };
    sent.length = 0;
    await act(async () => { button('Try again').click(); });
    await settle();
    expect(sent[0]).toEqual({ value: 'model-c', expect: 'model-a', cardGen: 1, changeId: first.changeId });
    expect(document.body.textContent).toContain('Changed elsewhere; nothing changed');
  });
});
