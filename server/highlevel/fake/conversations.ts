// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FakeHighLevelRoute } from '../fake-provider.ts';
import { HIGHLEVEL_OPERATION_MANIFEST } from '../operations/manifest.ts';
import { HIGHLEVEL_ENDPOINTS } from '../provider-contract.ts';
export const conversationsRoutes: readonly FakeHighLevelRoute[] = HIGHLEVEL_OPERATION_MANIFEST.filter(r => r.family === 'conversations' && r.disposition === 'ready').map(row => ({
  operation: row.id, method: HIGHLEVEL_ENDPOINTS[row.id]!.method, path: HIGHLEVEL_ENDPOINTS[row.id]!.path,
  handle({ path, body, query }) {
    const a = body as Record<string, unknown> | undefined;
    const locationId = a?.locationId ?? query?.locationId ?? 'loc_fixture_01', contactId = a?.contactId ?? query?.contactId ?? 'contact_1';
    const conversation = { id: 'conv_1', locationId, contactId };
    if (row.id === 'conversations.search') return { conversations: [conversation], total: 1 };
    if (row.id === 'conversations.get') return { ...conversation, id: decodeURIComponent(path.split('/')[2]!) };
    if (row.id === 'conversations.messages.list') return { messages: { messages: [], nextPage: false } };
    if (row.id === 'conversations.message.get' || row.id === 'conversations.email.get') return { id: decodeURIComponent(path.split('/').at(-1)!), locationId, contactId, conversationId: conversation.id, body: 'Fixture message' };
    if (row.send) return { messageId: 'msg_1', conversationId: conversation.id };
    if (row.id === 'conversations.create') return { success: true, conversation };
    if (row.id === 'conversations.attachment.upload') return { uploadedFiles: { 'letter.txt': 'https://fixture.invalid/letter.txt' }, status: 'success' };
    return { success: true };
  },
}));
export default conversationsRoutes;
