// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { OwnWriteCard } from "./OwnWriteCard";
import { setLocale } from "../lib/i18n";
import { isPendingApprovalMessage } from "../lib/pending-approval";
import type { Message } from "../state/store";
const message = (state: NonNullable<NonNullable<Message['card']>['writer']>['state'] = 'waiting', restored = false): Message => ({
  id: 'own-writer-card-hold', at: 1, role: 'bot', kind: 'options', card: { kind: 'own-write', title: 'Review this change', subtitle: 'W-ABC123', options: ['Allow', "Don't allow"], requestId: 'own-hold',
    writer: { version: 1, holdId: 'hold', stateRevision: 1, state, tool: 'update_bot', bodyHash: 'hash', ref: 'W-ABC123', detail: '{"role":"Reviewed role"}', ...(restored ? { restored: true } : {}) } },
});
afterEach(async () => { await setLocale('en'); });
it.each(['en','de','es','fr','hi','ja','pt-br','zh'])('renders a translated review with two touch targets in %s', async locale => {
  await setLocale(locale);
  const row = message(), html = renderToStaticMarkup(createElement(OwnWriteCard, { threadId: 'thread', message: row }));
  expect(html).toContain('W-ABC123'); expect(html).toContain('Reviewed role');
  expect(html.match(/<button /g)).toHaveLength(2); expect(html.match(/min-h-11/g)).toHaveLength(2);
  expect(html).not.toContain('ownWrite.'); expect(isPendingApprovalMessage(row)).toBe(false);
});
it.each(['approved','applying','applied','declined','expired','unknown'] as const)('terminal or claimed %s cards offer no new decision', state => {
  expect(renderToStaticMarkup(createElement(OwnWriteCard, { threadId: 'thread', message: message(state) }))).not.toContain('<button');
});
it('a restored waiting card offers only decline', () => {
  const html = renderToStaticMarkup(createElement(OwnWriteCard, { threadId: 'thread', message: message('waiting', true) }));
  expect(html.match(/<button /g)).toHaveLength(1); expect(html).toContain('backup'); expect(html).not.toContain('>Allow<');
});
