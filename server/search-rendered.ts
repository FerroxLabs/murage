import type { Message } from "./store.ts";
import { folderPromptShowing } from "../shared/mac-folder-prompt.ts";
import { hostStoppedReason, isStoppedMidDesktopAction } from "../shared/host-stop.ts";
import { folderTrustNotice } from "../shared/folder-trust.ts";
import { browserUnavailableReason } from "../shared/browser-unavailable.ts";
import { imagesLeftOutCount } from "../shared/images-left-out.ts";
import { imagesNotSent } from "../shared/turn-image-note.ts";
import { routineRunMarker } from "../shared/routine-run-marker.ts";
import { sendNoticeCode } from "../shared/send-notice.ts";
import { hermesPinNoteProfile } from "../shared/hermes-pin-note.ts";
import { TURN_STOPPED_NOTE } from "./turn-outcome.ts";

/** Search candidates must have a transcript row to land on. Cards and screens
 * are not search candidates. A folded tool run is reachable when tools are on. */
export function searchRowRendered(message: Message, showTools: boolean, now = Date.now()): boolean {
  if (message.kind !== "activity") return true;
  const tool = message.tool;
  if (!tool) return false;
  if (message.folderPrompt) return folderPromptShowing(message, now);
  if (showTools) return true;
  const name = tool.name;
  const done = tool.doneWhen?.trim();
  return Boolean(message.comm || done && [...done].length <= 280 || message.murage?.held ||
    Array.isArray(tool.steps) || tool.imageRecord || message.routineRunAgain || message.delegationWait || message.delegationHeld ||
    routineRunMarker(message) || sendNoticeCode(name) || message.memoryNote === "without-memory" ||
    hostStoppedReason(name) || isStoppedMidDesktopAction(name) || name === TURN_STOPPED_NOTE ||
    hermesPinNoteProfile(name) || folderTrustNotice(name) || browserUnavailableReason(name) ||
    imagesLeftOutCount(name) || imagesNotSent(name) || name.startsWith("error:"));
}
