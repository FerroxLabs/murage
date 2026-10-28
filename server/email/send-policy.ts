// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Who can [bot] email without asking?" (design 3.3): the decision Murage makes before any Flux call. Pure: the caller hands in the
// policy, the draft and which exact addresses the owner has approved.
//
//   ask   every send and reply waits on the owner
//   auto  a reply to an approved first-writer, or a send to approved addresses, goes out; anything else waits
// Content triggers hold under both policies: any attachment; more than 3 email addresses (in the text, or as recipients) or more than
// 8,000 characters; a reply whose source is unauthenticated, not DMARC aligned, list mail, or not scanned complete and clear; any reply
// recipient besides the stored From; a cc to anyone not approved.
import { normalizeAddresses } from "./canonical.ts";
import type { ReplySource } from "./email-store.ts";

export type WhyCode =
  | "owner_send" | "approved_first_writer" | "trusted"
  | "waiting_ask" | "waiting_new_contact" | "waiting_attachment" | "waiting_long" | "waiting_many_addresses" | "waiting_source_unverified"
  | "waiting_extra_recipients" | "waiting_cc";

export const MAX_TEXT_CHARS = 8_000;
export const MAX_ADDRESSES = 3;

const ADDRESS_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface PolicyInput {
  policy: "ask" | "auto";
  kind: "send" | "reply";
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachmentCount: number;
  replySource: ReplySource | null;
  isApproved: (address: string) => boolean;
}
export interface PolicyDecision { needsOwner: boolean; why: WhyCode }

export function distinctAddressesInText(text: string): number {
  return new Set((text.match(ADDRESS_IN_TEXT) ?? []).map(address => address.toLowerCase())).size;
}

export function decideSend(input: PolicyInput): PolicyDecision {
  const to = normalizeAddresses(input.to), cc = normalizeAddresses(input.cc);
  if (input.attachmentCount > 0) return { needsOwner: true, why: "waiting_attachment" };
  if (input.text.length > MAX_TEXT_CHARS) return { needsOwner: true, why: "waiting_long" };
  if (distinctAddressesInText(`${input.subject}\n${input.text}`) > MAX_ADDRESSES || to.length + cc.length > MAX_ADDRESSES) return { needsOwner: true, why: "waiting_many_addresses" };
  if (input.kind === "reply") {
    const source = input.replySource;
    if (!source || !source.senderAuthenticated || source.listMail || source.scanStatus !== "complete" || source.scanVerdict !== "clear") return { needsOwner: true, why: "waiting_source_unverified" };
    const from = source.from.trim().toLowerCase();
    if (to.some(address => address !== from)) return { needsOwner: true, why: "waiting_extra_recipients" };
    if (cc.some(address => !input.isApproved(address))) return { needsOwner: true, why: "waiting_cc" };
    if (input.policy === "ask") return { needsOwner: true, why: "waiting_ask" };
    return input.isApproved(from) ? { needsOwner: false, why: "approved_first_writer" } : { needsOwner: true, why: "waiting_new_contact" };
  }
  if (cc.some(address => !input.isApproved(address))) return { needsOwner: true, why: "waiting_cc" };
  if (input.policy === "ask") return { needsOwner: true, why: "waiting_ask" };
  return to.length > 0 && to.every(address => input.isApproved(address)) ? { needsOwner: false, why: "trusted" } : { needsOwner: true, why: "waiting_new_contact" };
}
