// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Whether a fake engine's prompt asks for a fixture marker. The request is the prompt's last line; text the product itself appends
// after the owner's words (the room reply trailer, the delegation pack's context block) is not part of the request.
const ROOM_REPLY_TRAILER = /^\(Reply to the conversation above as .+\.\)$/;
// The delegation pack input row (bf42746ca) rides after the delegated message as one fenced block of kind=delegation-context.
// Dispatch appends up to 3 such packs (server/index.ts, thread-recall.ts releaseDelegationPacks), so the whole trailing run is stripped.
const DELEGATION_CONTEXT = /\n*<<page-content id=(\S+) origin=\S+ kind=delegation-context>>\n[\s\S]*?\n<<end page-content id=\1>>\s*$/;

export const fixtureRequested = (text: string, marker: string): boolean => {
  let body = text.trimEnd();
  for (let stripped = body.replace(DELEGATION_CONTEXT, "").trimEnd(); stripped !== body; stripped = body.replace(DELEGATION_CONTEXT, "").trimEnd()) body = stripped;
  const lines = body.split("\n");
  if (lines.length > 1 && ROOM_REPLY_TRAILER.test(lines.at(-1) ?? "")) { lines.pop(); while (lines.length > 1 && !lines.at(-1)?.trim()) lines.pop(); }
  // Test-only: a plain substring match, so ordinary text that merely quotes a marker also fires. That is the old behaviour and is kept.
  return (lines.pop() ?? "").includes(marker);
};
