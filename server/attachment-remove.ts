// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// POST /api/storage/attachments/remove (1.0.4 SL-H H1, H4): the Storage page's
// Remove, for one or more stored attachment names. The owner's desktop only,
// never on a Cloud home (route-policy.ts). Kept out of index.ts so the
// request's rules are tested without a server; the filesystem work is
// attachments.ts removeAttachment (marker first, then the file).
//
// Every name is checked before any filesystem call: a body with one name that
// is not a stored attachment's is refused whole. A bot's picture is refused
// until the picture changes. A name whose marker could not be written answers
// 500 and nothing of it is deleted.
import { z } from "zod";
import { isAttachmentName } from "./attachment-read.ts";
import type { RemoveResult } from "./attachments.ts";
import { MANAGED_NAME, PAGE_LIMIT_MAX } from "./storage-attachments.ts";

export const PICTURE_IN_USE_MESSAGE = "Change the bot's picture first";
export const REMOVE_FAILED_MESSAGE = "That file could not be removed. Try again.";

export type RemoveOutcome =
  | { name: string; state: "removed" | "pending" }
  | { name: string; state: "refused" | "failed"; error: string };

export interface RemoveDeps {
  /** Bots in memory: a name that is one's picture is refused (H4). */
  bots: () => ReadonlyArray<{ avatarUrl?: string | null }>;
  remove: (name: string) => RemoveResult;
}

const body = z.object({ names: z.array(z.string()).min(1).max(PAGE_LIMIT_MAX) }).strict();

/** A stored attachment's name, checked with no filesystem call. */
export const removableName = (name: string): boolean => MANAGED_NAME.test(name) && isAttachmentName(name);

export function removeAttachments(input: unknown, deps: RemoveDeps): { status: 200 | 400 | 409 | 500; body: { results: RemoveOutcome[] } | { error: string } } {
  const parsed = body.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "names is a list of 1 to 100 attachment names" } };
  const names = [...new Set(parsed.data.names)];
  if (!names.every(removableName)) return { status: 400, body: { error: "That is not a stored attachment's name" } };
  const pictures = new Set(deps.bots().map(bot => bot.avatarUrl).filter((url): url is string => typeof url === "string"));
  const results = names.map((name): RemoveOutcome => {
    if (pictures.has(`/api/attachments/${name}`)) return { name, state: "refused", error: PICTURE_IN_USE_MESSAGE };
    const done = deps.remove(name);
    if (done.state === "failed") return { name, state: "failed", error: REMOVE_FAILED_MESSAGE };
    return { name, state: done.state };
  });
  const status = results.some(result => result.state === "failed") ? 500
    : results.every(result => result.state === "refused") ? 409 : 200;
  return { status, body: { results } };
}
