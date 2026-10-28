// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every word the phone tools say to a bot or to the owner, in one place (plan S20, global constraint on copy). rpc.ts, jobs.ts and the turn
// instructions read from here; nothing else spells these lines. No em dash, none of the banned words (copy.test.ts holds the line).
import { PHONE_COPY } from "../../shared/phone-copy.ts";
export { PHONE_COPY };

export type PhoneRpcCopy = Pick<typeof PHONE_COPY, "refused" | "invalidArgs">;

/**
 * The lines added to a turn's instructions. A bot with no phone grant gets nothing. A grant on a turn that holds the phone tools gets the
 * instruction lines; a grant on any other turn (no authority: a queued line, a room, a routine, a shared line) gets the withheld note; a `via` turn gets the one that names Ask again.
 */
export function phoneInstructionLines(input: { hasGrant: boolean; offered: boolean; authority: boolean; mounted: boolean; via?: boolean }): string[] {
  if (!input.hasGrant || !input.offered) return [];
  // A share or ask-intent turn never holds the phone tools, whatever is mounted.
  if (input.via) return [PHONE_COPY.withheldVia];
  if (input.mounted) return [...PHONE_COPY.instructions];
  return input.authority ? [] : [PHONE_COPY.withheld];
}
