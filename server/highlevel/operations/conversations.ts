import type { OperationHooks } from '../operation-hooks.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { HighLevelError } from '../errors.ts';
import { HIGHLEVEL_ENDPOINTS } from '../provider-contract.ts';
import { bindReturnedIdentities, returnedIdentitySchemaFor } from '../returned-identities.ts';
import type { FrozenRequest, HeldRequest } from '../held-request.ts';
import type { OperationSpec, OperationRunContext, PreflightRequester, RequestDraft, SpecBase } from './registry.ts';
import { HIGHLEVEL_OPERATION_MANIFEST } from './manifest.ts';
import { highlevelIdSchema } from './schemas/common.ts';

type Args = Record<string, any>;
const record = (value: unknown): Args => value && typeof value === 'object' && !Array.isArray(value) ? value as Args : {};
const validId = (value: unknown): value is string => highlevelIdSchema.safeParse(value).success;
function refuse(): never { throw new HighLevelError('The conversation, recipient or attachment could not be verified.', { status: 403 }); }
function unknown(): never { throw new HighLevelError('The message result could not be confirmed.', { outcome: 'outcome_unknown' }); }

// The host supplies its capability scope and authority binding. Weak keys
// prevent attachments surviving a turn; entries also bind connection epochs.
interface ConversationContext extends OperationRunContext { readonly scope?: object; readonly authorityBinding?: string }
const requests = new WeakMap<FrozenRequest, ConversationContext>();
type AttachmentDetails = Readonly<{ name: string; size: number; sha256: string }>;
const selectedAttachments = new WeakMap<OperationRunContext, readonly AttachmentDetails[]>();
const reviewedAttachments = new WeakMap<FrozenRequest, readonly AttachmentDetails[]>();
// The generic desktop values hook reads metadata retained for
// the exact held send, whose handle and URL are bound by the review digests.
// This never enriches the journal, redacted row, receipt or engine arguments.
export function conversationSendAttachmentValues(held?: HeldRequest): AttachmentDetails[] {
  return (held ? reviewedAttachments.get(held.frozen) ?? [] : []).map(file => ({ ...file }));
}
type Attachment = { url: string; conversationId: string; locationId: string; binding: string; name: string; size: number; sha256: string; expires: number };
const attachments = new WeakMap<object, Map<string, Attachment>>();
export function retainConversationRequest(held: HeldRequest, ctx: ConversationContext): void {
  if (held.frozen.operation.startsWith('conversations.')) {
    requests.set(held.frozen, Object.freeze({ ...ctx }));
    conversationUploadParent(held);
    const details = selectedAttachments.get(ctx);
    if (details) reviewedAttachments.set(held.frozen, details);
  }
}
// Additive provider confirmation for F3's two response
// shapes without record IDs. The common binder invokes this only AFTER scanning
// every field for conflicting identities and negative confirmations.
export function conversationResponseConfirmed(value: unknown, frozen: FrozenRequest): boolean {
  const v = record(value);
  if (['conversations.schedule.cancel', 'conversations.schedule.cancelEmail'].includes(frozen.operation)) return v.status === 200;
  if (frozen.operation !== 'conversations.attachment.upload' || !frozen.upload) return false;
  const files = record(v.uploadedFiles), entries = Object.entries(files);
  if (entries.length !== 1 || entries[0]![0] !== frozen.upload.name || typeof entries[0]![1] !== 'string' || entries[0]![1].length > 8192) return false;
  try { const url = new URL(entries[0]![1]); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; } catch { return false; }
}
const titles: Record<string, string> = {
  search: 'Search conversations', get: 'Read a conversation', 'messages.list': 'List conversation messages', 'message.get': 'Read a message', 'email.get': 'Read an email',
  create: 'Create a conversation', update: 'Update a conversation', delete: 'Delete a conversation',
  'send.sms': 'Send a text', 'send.email': 'Send an email', 'send.whatsapp': 'Send a WhatsApp message', 'send.facebook': 'Send a Facebook message',
  'send.instagram': 'Send an Instagram message', 'send.gmb': 'Send a Google Business message', 'send.livechat': 'Send a live chat message',
  'send.scheduledSms': 'Schedule a text', 'send.scheduledEmail': 'Schedule an email', 'schedule.cancel': 'Cancel a scheduled message',
  'schedule.cancelEmail': 'Cancel a scheduled email', 'attachment.upload': 'Upload a message attachment',
};
function checkContext(a: Args, ctx: OperationRunContext): void {
  if (!validId(ctx?.locationId) || (a.locationId !== undefined && a.locationId !== ctx.locationId)) refuse();
}
function owned(value: unknown, id: string, locationId: string, wrapper?: string): Args {
  const outer = record(value), row = wrapper ? record(outer[wrapper]) : outer;
  if (row.id !== id || row.locationId !== locationId || (outer.locationId !== undefined && outer.locationId !== locationId)) refuse();
  return row;
}
async function ownership(verb: string, pre: PreflightRequester, a: Args, ctx: OperationRunContext): Promise<void> {
  checkContext(a, ctx);
  if (a.contactId && (verb === 'create' || verb.startsWith('send.'))) owned(await pre.read('contacts.get', { path: `/contacts/${encodeURIComponent(a.contactId)}` }), a.contactId, ctx.locationId, 'contact');
  if (a.conversationId && !['get'].includes(verb)) owned(await pre.read('conversations.get', { path: `/conversations/${encodeURIComponent(a.conversationId)}` }), a.conversationId, ctx.locationId);
  if (verb === 'schedule.cancel') owned(await pre.read('conversations.message.get', { path: `/conversations/messages/${encodeURIComponent(a.messageId)}` }), a.messageId, ctx.locationId);
  if (verb === 'schedule.cancelEmail') owned(await pre.read('conversations.email.get', { path: `/conversations/messages/email/${encodeURIComponent(a.emailMessageId)}` }), a.emailMessageId, ctx.locationId);
}
function sendGuards(a: Args): void {
  // Provider schemas also serve other apps. F3 remains one contact, with no
  // address override, cc/bcc, reply-all, or unverified nested resource.
  if (a.emailTo !== undefined || a.toNumber !== undefined || a.emailCc?.length || a.emailBcc?.length || a.emailReplyMode === 'reply_all'
    || a.appointmentId !== undefined || a.replyMessageId !== undefined || a.threadId !== undefined || a.templateId !== undefined || a.userId !== undefined || a.mentions?.length) refuse();
  if (!a.message?.trim() && !a.html?.trim() && !a.attachments?.length) refuse();
}
async function sendBody(pre: PreflightRequester, a: Args, ctx: ConversationContext): Promise<Args> {
  sendGuards(a);
  const body = { ...a };
  if (a.attachments?.length) {
    if (!ctx.scope || new Set(a.attachments).size !== a.attachments.length || a.attachments.length > 10) refuse();
    const saved = attachments.get(ctx.scope);
    const refs = a.attachments.map((id: string) => saved?.get(id));
    if (refs.some((ref: Attachment | undefined) => !ref || ref.locationId !== ctx.locationId || ref.binding !== (ctx.authorityBinding ?? '') || ref.expires < Date.now())) refuse();
    // The attachment's conversation must still belong to this one recipient.
    const result = record(await pre.read('conversations.search', { path: '/conversations/search', query: { locationId: ctx.locationId, contactId: a.contactId, limit: '50' } }));
    const conversations = Array.isArray(result.conversations) ? result.conversations.map(record) : [];
    for (const ref of refs as Attachment[]) if (!conversations.some((c: Args) => c.id === ref.conversationId && c.locationId === ctx.locationId && c.contactId === a.contactId)) refuse();
    body.attachments = (refs as Attachment[]).map(ref => ref.url);
    selectedAttachments.set(ctx, Object.freeze((refs as Attachment[]).map(ref => Object.freeze({ name: ref.name, size: ref.size, sha256: ref.sha256 }))));
  }
  return body;
}

const scalarFields = new Set(['id','contactId','locationId','conversationId','emailMessageId','messageId','altId','threadId','type','messageType','fullName','contactName','email','phone','unreadCount','assignedTo','starred','deleted','inbox','lastMessageBody','lastMessageType','lastMessageDate','dateAdded','dateUpdated','body','subject','direction','status','contentType','source','total','success','nextPage','lastMessageId']);
const IDENTITY = ['id','messageId','emailMessageId','conversationId','contactId','locationId'];
const RECORD_MIN = 512;
function bounded(value: unknown, depth = 0, budget = { left: 64_000 }, full = false): unknown {
  if (budget.left < 64 || depth > 6) { if (full) unknown(); return undefined; }
  if (typeof value === 'string') { const out = full ? value : value.slice(0, Math.min(4000, Math.floor((budget.left - 8) / 6))); budget.left -= Buffer.byteLength(JSON.stringify(out)) + 4; if (full && budget.left < 0) unknown(); return out; }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) { budget.left -= 32; return value; }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const child of value.slice(0, 50)) {
      // Reserve a whole record's identity and omission metadata before entry.
      if (!full && budget.left < RECORD_MIN) break;
      out.push(bounded(child, depth + 1, budget, full));
    }
    return out;
  }
  const out: Args = {}, source = record(value);
  if (!full) for (const key of IDENTITY) if (Object.hasOwn(source, key)) {
    out[key] = source[key];
    budget.left -= Buffer.byteLength(JSON.stringify({ [key]: source[key] })) + 4;
  }
  for (const [key, child] of Object.entries(source)) {
    if (!full && IDENTITY.includes(key)) continue;
    const scalar = scalarFields.has(key) && (child === null || ['string','number','boolean'].includes(typeof child));
    const nested = ['conversations','conversation','messages'].includes(key);
    if (!scalar && !nested && key !== 'attachments') continue;
    if (budget.left < 256) {
      if (full) unknown();
      (out.omittedFields ??= []).push(key);
      continue;
    }
    budget.left -= Buffer.byteLength(JSON.stringify(key)) + 4;
    if (scalar || nested) {
      out[key] = bounded(child, depth + 1, budget, full);
      if (typeof child === 'string' && out[key] !== child) (out.truncatedFields ??= []).push(key);
    }
    else if (key === 'attachments') out[key] = typeof child === 'number' ? child : Array.isArray(child) ? child.length : 0;
  }
  return out;
}
function validateRead(verb: string, value: unknown, frozen?: FrozenRequest): void {
  if (!frozen) return; // Pure projection callers have no authority to dispatch.
  const ctx = requests.get(frozen); if (!ctx) refuse();
  const v = record(value), expected = decodeURIComponent(frozen.path.split('/').at(-1)!);
  if (['get','message.get','email.get'].includes(verb)) owned(v, expected, ctx.locationId);
  if (verb === 'search') {
    if (!Array.isArray(v.conversations) || v.conversations.some((c: unknown) => !validId(record(c).id) || record(c).locationId !== ctx.locationId)) refuse();
  }
  if (verb === 'messages.list') {
    const parent = decodeURIComponent(frozen.path.split('/')[2]!);
    const page = Array.isArray(v.messages) ? v.messages : record(v.messages).messages;
    if (!Array.isArray(page) || page.some((m: unknown) => !validId(record(m).id) || (record(m).locationId !== undefined && record(m).locationId !== ctx.locationId) || (record(m).conversationId !== undefined && record(m).conversationId !== parent))) refuse();
  }
}
function mutationResult(value: unknown, frozen?: FrozenRequest): Args {
  if (!frozen || bindReturnedIdentities(value, frozen, returnedIdentitySchemaFor(frozen)).status !== 'applied') unknown();
  const v = record(value);
  if (frozen.operation.startsWith('conversations.send.') && (!validId(v.conversationId) || (!validId(v.messageId) && !validId(v.emailMessageId) && !(Array.isArray(v.messageIds) && v.messageIds.length && v.messageIds.every(validId))))) unknown();
  if (frozen.operation === 'conversations.create' && !validId(record(v.conversation).id)) unknown();
  return v;
}
function projectUpload(value: unknown, frozen: FrozenRequest): unknown {
  const ctx = requests.get(frozen); if (!ctx?.scope || !frozen.upload) unknown();
  const v = record(value), files = v.uploadedFiles;
  const urls = Array.isArray(files) ? files.map(f => typeof f === 'string' ? f : record(f).url) : Object.values(record(files));
  if (urls.length !== 1 || typeof urls[0] !== 'string') unknown();
  let url: URL; try { url = new URL(urls[0]); } catch { return unknown(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) unknown();
  const conversationId = frozen.query.find(([k]) => k === 'conversationId')?.[1];
  // The provider's multipart field is retained privately by the host hook.
  const parent = uploadParents.get(frozen) ?? conversationId; if (!parent) unknown();
  let saved = attachments.get(ctx.scope); if (!saved) { saved = new Map(); attachments.set(ctx.scope, saved); }
  for (const [key, ref] of saved) if (ref.expires < Date.now()) saved.delete(key);
  if (saved.size >= 200) unknown();
  const attachmentId = `hlfile_${randomUUID().replaceAll('-', '')}`;
  saved.set(attachmentId, { url: url.href, conversationId: parent, locationId: ctx.locationId, binding: ctx.authorityBinding ?? '', name: frozen.upload.name, size: frozen.upload.size, sha256: frozen.upload.sha256, expires: Date.now() + 600_000 });
  return { uploadedFiles: [{ attachmentId, name: frozen.upload.name, size: frozen.upload.size, sha256: frozen.upload.sha256 }] };
}
const uploadParents = new WeakMap<FrozenRequest, string>();
// Extract from verified held bytes only, never from mutable call arguments.
export function conversationUploadParent(held: HeldRequest): string | undefined {
  if (held.frozen.operation !== 'conversations.attachment.upload') return;
  const copy = held.sendCopy();
  const text = Buffer.from(copy.body!.subarray(0, copy.fileOffset!)).toString('utf8');
  const parent = text.match(/name="conversationId"\r\n\r\n([^\r\n]+)\r\n/)?.[1];
  if (!validId(parent)) refuse(); uploadParents.set(held.frozen, parent); return parent;
}

export const conversationsOperations: readonly OperationSpec[] = HIGHLEVEL_OPERATION_MANIFEST.filter(row => row.family === 'conversations' && row.disposition === 'ready').map(row => {
  if (row.disposition !== 'ready') throw Error('Conversation manifest');
  const verb = row.id.slice('conversations.'.length);
  const base: SpecBase & OperationHooks = {
    id: row.id, family: 'conversations', title: titles[verb]!, row, endpoint: HIGHLEVEL_ENDPOINTS[row.id]!, args: row.argsSchema as z.ZodType<Args>,
    preflight: row.preflight, nested: row.preflight.length > 0,
    recordRefs: a => ['contactId','conversationId','messageId','emailMessageId'].map(k => a[k]).filter(validId),
    fields: a => Object.keys(a).filter(k => !['locationId','contactId','conversationId','messageId','emailMessageId','type','status'].includes(k)).sort(),
    targets: () => 1,
    retainRequest: retainConversationRequest,
    reviewValues: held => { const details = conversationSendAttachmentValues(held); return details.length ? { attachmentDetails: details } : {}; },
    confirmsResponse: conversationResponseConfirmed,
    ownership: (pre, input, ctx) => ownership(verb, pre, row.argsSchema.parse(input) as Args, ctx),
    project(value: unknown, frozen?: FrozenRequest) {
      if (row.risk === 'R') validateRead(verb, value, frozen);
      else { mutationResult(value, frozen); if (verb === 'attachment.upload') return projectUpload(value, frozen!); }
      const v = record(value);
      const selected = Object.fromEntries(row.projection.filter(k => Object.hasOwn(v, k)).map(k => [k, v[k]]));
      // Keep pagination inside the declared messages envelope, including the
      // shortened page cursor when the byte budget ends before the provider page.
      if (verb === 'messages.list') {
        const page = Array.isArray(v.messages) ? { messages: v.messages, nextPage: v.nextPage, lastMessageId: v.lastMessageId } : record(v.messages);
        const messages = bounded(page.messages) as Args[] | undefined;
        const shortened = Array.isArray(page.messages) && (messages?.length ?? 0) < page.messages.length;
        const cursor = shortened ? messages?.at(-1)?.id : page.lastMessageId;
        return { messages: { messages: messages ?? [], nextPage: shortened || page.nextPage === true, ...(validId(cursor) ? { lastMessageId: cursor } : {}) } };
      }
      // Getter content is lossless, bounded by the transport's 4 MiB ceiling.
      // Lists remain previews and identify each shortened field explicitly.
      if (['message.get', 'email.get'].includes(verb)) return bounded(selected, 0, { left: 4 * 1024 * 1024 }, true);
      const preview = bounded(selected) as Args;
      if (verb === 'search' && Array.isArray(v.conversations) && (preview.conversations?.length ?? 0) < v.conversations.length) preview.shortened = true;
      return preview;
    },
  };
  const draft = async (input: Args, ctx: ConversationContext, pre?: PreflightRequester): Promise<RequestDraft> => {
    const a = row.argsSchema.parse(input) as Args; checkContext(a, ctx);
    const path = row.path.replace(/:([A-Za-z]+)/g, (_, key) => encodeURIComponent(a[key]));
    const resource = row.pathResourceSegment === null ? `location:${ctx.locationId}` : `conversations:record:${decodeURIComponent(path.split('/')[row.pathResourceSegment]!)}`;
    if (row.risk === 'R') {
      const query: Record<string, string> = {};
      for (const [key, value] of Object.entries(a)) if (!row.path.includes(`:${key}`) && value !== null && value !== undefined) query[key] = String(value);
      if (verb === 'search' || verb === 'messages.list') query.limit = String(Math.max(1, Math.min(50, Number(a.limit) || 20)));
      return { path, resource, ...(Object.keys(query).length ? { query } : {}) };
    }
    if (verb === 'attachment.upload') {
      if (!ctx.prepared || ctx.prepared.size > 5_000_000) refuse();
      return { path, resource, body: { kind: 'multipart', fields: { conversationId: a.conversationId }, file: { field: 'fileAttachment', upload: ctx.prepared } } };
    }
    if (row.send) return { path, resource, body: { kind: 'json', value: await sendBody(pre!, a, ctx) } };
    if (verb === 'create') return { path, resource, body: { kind: 'json', value: { locationId: ctx.locationId, contactId: a.contactId } } };
    if (verb === 'update') {
      const { conversationId: _id, ...body } = a;
      if (body.starred === undefined && body.unreadCount === undefined && body.feedback === undefined) refuse();
      if (body.unreadCount !== undefined && (!Number.isSafeInteger(body.unreadCount) || body.unreadCount < 0)) refuse();
      return { path, resource, body: { kind: 'json', value: body } };
    }
    return { path, resource };
  };
  if (row.risk === 'R') return { ...base, risk: 'R', maxReads: 1, prepareRead: (a, ctx) => draft(a, ctx) };
  const mutation = { ...base, risk: row.risk, gate: row.gate as 'GC' | 'GC+' | 'GD', send: row.send, precondition: row.precondition,
    prepare: (pre, a, ctx) => draft(a, ctx, pre),
    recoveryTargets: held => {
      if (verb === 'attachment.upload') return [{ operation: 'conversations.messages.list', path: `/conversations/${encodeURIComponent(conversationUploadParent(held)!)}/messages` }];
      if (verb.startsWith('schedule.')) return [{ operation: verb === 'schedule.cancelEmail' ? 'conversations.email.get' : 'conversations.message.get', path: held.frozen.path.replace(/\/schedule$/, '') }];
      if (['update', 'delete'].includes(verb)) return [{ operation: 'conversations.get', path: held.frozen.path }];
      return [{ operation: 'conversations.search', path: '/conversations/search', query: { locationId: requests.get(held.frozen)!.locationId, limit: '50' } }];
    },
    recordId(value: unknown, frozen?: FrozenRequest) { const v = mutationResult(value, frozen); const id = v.messageId ?? v.emailMessageId ?? record(v.conversation).id; return validId(id) ? id : undefined; },
  } satisfies OperationSpec & OperationHooks;
  return mutation;
});
export default conversationsOperations;
