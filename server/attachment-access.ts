// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Who may be shown a saved image (0.1.62 audit C4).
//
// The desktop sees every attachment. A paired phone or the browser door sees
// an attachment only when it belongs to something that surface may see: a
// message in a visible conversation, or the avatar of a visible bot. An image
// that only a hidden bot, an archived room or a bot-to-bot room mentions looks
// missing, the same answer as a name that was never saved. An image nothing
// mentions yet (an upload still waiting to be sent) is shown only to the
// kind of remote caller that uploaded it, for a short while (RemoteUploadGrants).
// Once any message mentions it, or a bot avatar is set to it, the exception is
// consumed at that moment (not at some later GET): from then on it is shown
// only while a visible conversation (or a visible bot's avatar) owns it.
//
// The route itself is already behind the desktop or companion proof
// (route-policy.ts); this decides what a proven remote caller is shown.

export interface AttachmentAccessStore {
  visibleThreadIds(): string[];
  bots: ReadonlyArray<{ hidden?: boolean; avatarUrl?: string }>;
}

/** How long an unsent remote upload may be fetched back by the surface that uploaded it. */
export const REMOTE_UPLOAD_TTL_MS = 10 * 60_000;
const REMOTE_UPLOAD_MAX = 512;

/** The temporary exception for a picture a remote surface uploaded and has not sent yet.
 * Each grant belongs to one uploader (the proof class the upload arrived with, so a
 * phone's upload is not readable by the browser door or a script), expires on its own,
 * and is consumed the moment a message mentions the picture or an avatar adopts it. */
export class RemoteUploadGrants {
  private readonly grants = new Map<string, { uploader: string; expiresAt: number }>();
  /** Names already adopted by a message or an avatar: an idempotent upload retry must not re-open them. */
  private readonly adopted = new Set<string>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(ttlMs = REMOTE_UPLOAD_TTL_MS, now: () => number = Date.now) { this.ttlMs = ttlMs; this.now = now; }
  /** Issue a grant for an upload route result. Only a file this request newly
   * created carries the original pending-upload entitlement: an idempotent
   * retry that finds the file already there gets no new grant (the first
   * request's grant, if still live, stands untouched), so no history has to be
   * remembered to keep an ended exception ended: not across the bounded set,
   * not across a restart. */
  grantUpload(name: string, uploader: string, createdNow: boolean): void {
    if (createdNow) this.grant(name, uploader);
  }
  grant(name: string, uploader: string): void {
    if (this.adopted.has(name.toLowerCase())) return;
    this.grants.delete(name);
    this.grants.set(name, { uploader, expiresAt: this.now() + this.ttlMs });
    while (this.grants.size > REMOTE_UPLOAD_MAX) this.grants.delete(this.grants.keys().next().value as string);
  }
  allows(name: string, uploader: string): boolean {
    const found = this.grants.get(name);
    if (!found) return false;
    if (found.expiresAt <= this.now()) { this.grants.delete(name); return false; }
    return found.uploader === uploader;
  }
  release(name: string): void { this.grants.delete(name); }
  /** A message or an avatar has adopted the picture: the exception is over now, whatever is fetched later. */
  consume(ref: string): void {
    const found = attachmentNameFromRef(ref);
    if (!found) return;
    const name = found.toLowerCase();
    this.grants.delete(name); this.grants.delete(found);
    this.adopted.delete(name); this.adopted.add(name);
    while (this.adopted.size > 4 * REMOTE_UPLOAD_MAX) this.adopted.delete(this.adopted.values().next().value as string);
  }
}

/** The stored filename inside an attachment reference (an `/api/attachments/<name>` URL or a file path), or null. */
export function attachmentNameFromRef(ref: string): string | null {
  const name = ref.split(/[\\/?#]/).filter(Boolean).at(-1) ?? ref;
  return /^[A-Za-z0-9-]+\.(png|jpg|jpeg|gif|webp)$/i.test(name) ? name : null;
}

/** The extension half of a filename-shaped token. The name before it is found by
 * walking back (see {@link filenameTokensIn}): a regex of the form `[A-Za-z0-9-]+\.ext`
 * retries from every position of a long run of name characters with no dot (an
 * 850 KB message is one), which is quadratic and froze the server. */
const NAME_EXTENSION = /\.(?:png|jpg|jpeg|gif|webp)/gi;
const isNameChar = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45;
/** Every `<name chars>.<picture extension>` token, leftmost and non-overlapping, in linear time. */
function filenameTokensIn(text: string): string[] {
  const found: string[] = [];
  let floor = 0;
  for (const ext of text.matchAll(NAME_EXTENSION)) {
    const dot = ext.index;
    let start = dot;
    while (start > floor && isNameChar(text.charCodeAt(start - 1))) start--;
    if (start === dot) continue;
    const end = dot + ext[0].length;
    found.push(text.slice(start, end));
    floor = end;
  }
  return found;
}
/** THE definition of "a message references a stored picture", shared by visibility
 * (threadsReferencingAttachment) and adoption (the message observer): the
 * message's structured attachment paths plus every filename-shaped token anywhere
 * in its JSON (attached-image tags, markdown images, plain text), matched without
 * regard to case. Basenames retain their first spelling; compare with {@link sameAttachmentName}. */
export function attachmentReferencesIn(messageJson: string, structuredPaths: readonly string[] = []): string[] {
  const names: string[] = [], seen = new Set<string>();
  for (const ref of [...structuredPaths, ...filenameTokensIn(messageJson)]) {
    const name = attachmentNameFromRef(ref);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase()); names.push(name);
  }
  return names;
}
export const sameAttachmentName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
/** Whether this message JSON references the bare stored name (the same definition adoption uses). */
export function messageJsonReferences(messageJson: string, name: string): boolean {
  return attachmentReferencesIn(messageJson).some(ref => sameAttachmentName(ref, name));
}

export function attachmentVisibleToRemote(
  store: AttachmentAccessStore,
  name: string,
  threadsReferencing: (name: string) => string[],
  uploads: RemoteUploadGrants,
  uploader: string,
): boolean {
  // A visible conversation or a visible bot's avatar shows the picture. A mention in a
  // hidden conversation takes nothing away from the other.
  const referencing = threadsReferencing(name);
  const visible = new Set(store.visibleThreadIds());
  if (referencing.some(threadId => visible.has(threadId))) return true;
  const url = `/api/attachments/${name}`;
  if (store.bots.some(bot => bot.hidden !== true && bot.avatarUrl === url)) return true;
  // Sent into any conversation: the upload exception is over, visibility alone decides.
  if (referencing.length > 0) { uploads.release(name); return false; }
  return uploads.allows(name, uploader);
}
