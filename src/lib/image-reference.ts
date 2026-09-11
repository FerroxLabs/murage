// "Use as reference" (0.1.52 F5-T4, IMG-SEED). Choosing an image adds it to
// the next message of its own conversation as an attached image chip. It does
// not generate or bill anything: the bot still has to ask for an image edit,
// and the owner still approves that paid request.
//
// The conversation is always the image's own. A chat image targets the
// composer of the conversation on screen, and the harness refuses the request
// unless that conversation really holds the image. A saved Files image names
// its conversation, and the action is only offered while that conversation's
// composer is open. Nothing here reads a path from message text as authority.
import type { Artifact } from "../../shared/artifacts";
import {
  IMAGE_REFERENCE_LIMITS, IMAGE_REFERENCE_MIMES, MEDIA_ROUTES,
  type ImageReferenceSource, type MediaReferenceRequest, type MediaReferenceResponse,
} from "../../shared/media-assets";
import { attachmentBasename, type ImageAttachment } from "./composer-attachments";
import { appendComposerDraftAttachments } from "./drafts";

/** A mounted composer that can receive a reference chip. */
export interface ComposerReferenceTarget { threadId: string; draftId: string; botId?: string }

const targets: ComposerReferenceTarget[] = [];
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** Called by a composer while it is mounted. Returns its unregister. */
export function registerComposerReferenceTarget(target: ComposerReferenceTarget): () => void {
  const entry = { ...target };
  targets.push(entry);
  notify();
  return () => {
    const index = targets.indexOf(entry);
    if (index >= 0) targets.splice(index, 1);
    notify();
  };
}

/** The most recently mounted composer, or the one for `threadId`. */
export function composerReferenceTarget(threadId?: string): ComposerReferenceTarget | undefined {
  for (let index = targets.length - 1; index >= 0; index--) {
    const target = targets[index]!;
    if (threadId === undefined || target.threadId === threadId) return target;
  }
  return undefined;
}

export function subscribeComposerReferenceTargets(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const ATTACHMENT_NAME = /^[A-Za-z0-9-]{1,160}\.(png|jpg|jpeg|webp)$/i;

/** A transcript image the attachment server wrote. GIF and anything that is
 * not a generated attachment name cannot be a reference. */
export function attachmentReferenceSource(path: string): ImageReferenceSource | null {
  const name = attachmentBasename(path);
  return ATTACHMENT_NAME.test(name) ? { kind: "attachment", attachmentId: name } : null;
}

/** A saved Files image, pinned to the exact version shown. A row without its
 * type, size or digest cannot be pinned, so it is not offered. */
export function artifactReferenceSource(artifact: Pick<Artifact, "id" | "sha256"> & Partial<Pick<Artifact, "mime" | "bytes">>): ImageReferenceSource | null {
  if (!artifact.id || !artifact.sha256) return null;
  if (!(IMAGE_REFERENCE_MIMES as readonly string[]).includes(artifact.mime ?? "")) return null;
  if ((artifact.bytes ?? Number.POSITIVE_INFINITY) > IMAGE_REFERENCE_LIMITS.maxBytesEach) return null;
  return { kind: "artifact", artifactId: artifact.id, sha256: artifact.sha256 };
}

function chipId(): string {
  try { return globalThis.crypto.randomUUID(); } catch { return `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
}

/** The composer chip for a pinned reference: an ordinary attached image, so
 * the message carries it the same way as an upload. */
export function referenceChip(response: MediaReferenceResponse, id = chipId()): ImageAttachment {
  return { kind: "image", id, path: response.attachment.path, name: response.attachment.name, size: response.attachment.bytes, mime: response.attachment.mime };
}

export type ReferenceRequester = (path: string, init: RequestInit) => Promise<unknown>;
export type AddImageReferenceResult =
  | { status: "added"; target: ComposerReferenceTarget; chip: ImageAttachment }
  | { status: "no-conversation" };

/** Pin the image into the target conversation and add its chip to that
 * conversation's draft. Throws the harness's explanation when it refuses. */
export async function addImageReference(
  input: { source: ImageReferenceSource; threadId?: string; botId?: string },
  request: ReferenceRequester,
  append: (draftId: string, attachments: ImageAttachment[]) => void = appendComposerDraftAttachments,
): Promise<AddImageReferenceResult> {
  const target = composerReferenceTarget(input.threadId);
  if (!target) return { status: "no-conversation" };
  const botId = input.botId ?? target.botId;
  const body: MediaReferenceRequest = { threadId: target.threadId, ...(botId ? { botId } : {}), source: input.source };
  const response = await request(MEDIA_ROUTES.reference, { method: "POST", body: JSON.stringify(body) }) as MediaReferenceResponse;
  if (!response?.attachment?.path || !response.reference?.id) throw new Error("The image could not be prepared as a reference.");
  const chip = referenceChip(response);
  append(target.draftId, [chip]);
  return { status: "added", target, chip };
}
