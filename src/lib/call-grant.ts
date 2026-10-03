// SPDX-License-Identifier: AGPL-3.0-or-later
// What "yes for the rest of the call" covers.
//
// The owner's yes for the call lets the bot keep going on everyday lookups
// without asking each time. Anything that sends, pays, deletes, runs a
// command, changes a file, uses the computer or the browser, or that this
// code does not recognise, always shows its own card and gets its own yes.
// The list below is the only way in: a request is covered by name, never by
// default.
import { isHostConsentApproval, isRoutineApproval, isSkillApproval, knownToolAction, type Pending } from "@/components/PendingApproval";
import { isQuestionCard } from "../../shared/questions";

/** The everyday lookups a call-long yes covers, as `knownToolAction` words them. */
const COVERED = [/^search the web$/, /^look up which app tools to use$/, /^open a (web )?page\b/];
/** Details that name a key or a secret are always asked, whatever the action. */
const PRIVATE_LOOKING = /\b(key|token|secret|password|passwd|credential|bearer)\b|sk-[A-Za-z0-9]/i;

/** Is this approval one a call-long yes may answer on its own? */
export function coveredForCall(pending: Pending): boolean {
  if (isRoutineApproval(pending) || isSkillApproval(pending) || isHostConsentApproval(pending)) return false;
  const card = pending.message.card;
  if (!card || isQuestionCard(card)) return false;
  if (card.taskAllowKey || card.approvalScope || card.folderTrust || card.held) return false;
  if (card.allowKey && card.allowKey.startsWith("stop:")) return false;
  if (PRIVATE_LOOKING.test(`${pending.tool}\n${pending.detail}`)) return false;
  // The tool's own name decides first. `knownToolAction` also reads the
  // detail, so a shell command that merely mentions "google" or "git fetch"
  // would otherwise be worded, and covered, as a web lookup.
  if (ACTING_TOOL.test(toolWords(pending.tool))) return false;
  const byName = knownToolAction(pending.tool, "");
  if (byName !== null && !covered(byName)) return false;
  return covered(knownToolAction(pending.tool, pending.detail));
}

const covered = (action: string | null): boolean => action !== null && COVERED.some((re) => re.test(action));
/** A tool name split into words: "mcp__gmail__send_email" -> "send email", "SendEmail" -> "Send Email". */
const toolWords = (tool: string): string =>
  tool.replace(/^mcp__[^_]+__/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
/** A tool whose name says it acts rather than looks is never covered, whatever its detail says. */
const ACTING_TOOL =
  /\b(send|post|reply|email|message|delete|remove|drop|write|edit|patch|create|update|upload|pay|purchase|buy|transfer|exec|execute|run|bash|shell|terminal|command|computer|click|type|press|key|script)\b/i;

/** Said aloud when a call-long yes is taken, and again each time it is used:
 *  what carries on by itself, and what still gets a question first. */
export const FOR_CALL_SPOKEN =
  "Okay, for the rest of the call I'll go ahead with web searches and lookups. I'll still ask you first before sending a message, paying, deleting, running a command, changing a file, or using your computer.";
/** The same, shorter, for when a covered request goes through. */
export const FOR_CALL_OFFER = "Say yes, no, or yes for the rest of the call, which covers searches and lookups.";
