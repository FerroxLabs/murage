// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W (email design r9 3.2 I-5, section 8): a turn in a mailbox-sealed conversation writes nothing else of Murage's. Every own tool that
// persists something another conversation, a later turn or a phone can read (memory, routines, projects, Inbox items, bots, images,
// skills, sites, and lines into other conversations) is refused with one fixed line; a voice note is refused before synthesis. What
// stays: lines and cards in the conversation itself (sealed by sealSplit), reads, and the ordinary tools the shipped approvals govern.
// Messages to another conversation are refused rather than sealing it first (fail closed; DECISIONS 6), and so is an ask or
// delegation into a bot whose mailbox conversation is sealed (its answer would go back to the asker's conversation).
import { OWN_WRITERS } from "../outside-own.ts";

export const SEALED_TURN_WRITE_LINE = "Email conversations can't save anything outside this conversation (memory, routines, projects, the Inbox or other conversations).";
export const SEALED_TURN_VOICE_LINE = "Voice notes aren't available in email conversations.";
export const SEALED_TARGET_LINE = "That bot's conversation holds email, so other bots can't ask it or hand it work there.";

/** Own writers whose only write is a line or card in this same conversation (sealed by the store write) or that hold no content. */
const SAME_CONVERSATION: ReadonlySet<string> = new Set(["show_widget", "update_widget", "allow_for_task", "email_send", "email_reply", "email_trust_offer"]);
/** Persisting own tools outside the OWN_WRITERS list (it counts only what a later turn reads; these also reach files, sites or the Inbox). */
const ALSO_PERSISTS: ReadonlySet<string> = new Set(["register_artifact", "publish_site", "take_down_site", "skill_manage", "needs_owner_now", "ask_owner_to_share", "connectors_request"]);

/** `targetSealed` is asked only for an ask or hand-off (it is a lookup). A mailbox read in a turn another bot started needs no line
 *  here: email admission already refuses email tools in an asked turn (witnessed in read-seal.app.test.ts). */
export function sealedTurnRefusal(tool: string, input: { sealed: boolean; targetSealed: () => boolean }): string | null {
  if (!tool) return null;
  if (input.sealed) {
    if (tool === "send_voice_note") return SEALED_TURN_VOICE_LINE;
    if ((OWN_WRITERS.has(tool) && !SAME_CONVERSATION.has(tool)) || ALSO_PERSISTS.has(tool)) return SEALED_TURN_WRITE_LINE;
  }
  // an ask or hand-off into a sealed mailbox conversation runs on its engine session, which holds mail, and answers the asker
  if ((tool === "ask_bot" || tool === "delegate_bot") && input.targetSealed()) return SEALED_TARGET_LINE;
  return null;
}
