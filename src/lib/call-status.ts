// The 1:1 call screen's status line, as one pure decision so the order of
// precedence is tested by behaviour rather than read off CallView's source.
// "Call paused" wins over everything else: it explains why nothing is
// happening. "Connecting…" then wins over "Muted"/"Listening": the mic
// controls render before audio is really open, but nothing is being heard
// yet either way, and saying "Listening" for a call that never answered is
// the whole "couldn't connect" gap this status line is meant to close. The
// phase itself is a bare word (Listening, Speaking, Working): the bot's
// name is the line above, and "Ada" under "Ada" said nothing.
import { t } from "./i18n";
import type { CallPhase } from "./call-aura";

export function callStatusText(call: { phase: CallPhase; held: boolean; connecting: boolean; muted: boolean; pushToTalk: boolean }): string {
  if (call.held) return t("calls.status.paused");
  if (call.connecting) return t("calls.status.connecting");
  if (call.muted) return t("calls.status.muted");
  switch (call.phase) {
    case "listening":
      return call.pushToTalk ? t("calls.status.pushToTalk") : t("calls.status.listening");
    case "sending":
      return t("calls.status.oneMoment");
    case "speaking":
      return t("calls.status.speaking");
    default:
      return t("calls.status.working");
  }
}
