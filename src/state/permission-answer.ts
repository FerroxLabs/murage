// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one body an Allow or Deny on a permission card posts to `POST /api/threads/:id/respond`, from every surface:
// the card in the conversation (store decideRequest) and the Needs you row (InboxRequest). A bot's card reaches the
// renderer with only its display handle (`p.<message id>`, aliased onto `requestId` at the wire edge), so the answer
// must name that handle as a display action; the raw request id the server keeps private is never on this side.
// 1.0.22 q1022-approvefix: Needs you used to post the handle as a raw `requestId`, which matched no live request
// (503 delivery_retry on every click) while the chat card's display action went through.

export type PermissionAnswerExtra = {
  message?: string;
  reviewedSha256?: string;
  seen?: unknown;
  allowForTask?: boolean;
};

const PERMISSION_HANDLE = /^p\.[A-Za-z0-9-]+$/;

export function permissionAnswerBody(
  card: object | null | undefined,
  requestId: string,
  behavior: "allow" | "deny" | "answer",
  extra: PermissionAnswerExtra = {},
): Record<string, unknown> {
  const held = card && "requestHandle" in card ? (card as { requestHandle?: unknown }).requestHandle : undefined;
  const requestHandle = typeof held === "string" ? held : requestId;
  if (PERMISSION_HANDLE.test(requestHandle) && behavior !== "answer") return { requestHandle, action: behavior, ...(extra.allowForTask ? { allowForTask: true } : {}) };
  // A host card the server keeps a real request id on (an image, high-level or limit service record): the plain answer.
  return {
    requestId,
    behavior,
    message: extra.message,
    reviewedSha256: extra.reviewedSha256,
    ...(extra.seen ? { seen: extra.seen } : {}),
    ...(extra.allowForTask ? { allowForTask: true } : {}),
  };
}
