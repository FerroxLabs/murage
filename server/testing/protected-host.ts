/** Complete synthetic sources for host unit fixtures. Production obtains these from the call coordinator. */
import { mintCallPresentation, type PresentationFields } from "../tts/call-presentation.ts";
import { runVoiceBrief as brief, runVoiceHostTurn as host, type VoiceBriefOptions, type VoiceHostOptions } from "../voice/voice-host.ts";
export function fixturePresentation(fields: Pick<PresentationFields, "state"> & Partial<PresentationFields>) {
  return mintCallPresentation({ bootId: "fixture-boot", callId: "fixture-call", threadId: "fixture-thread", botId: "fixture-bot", generationId: "fixture-generation" },
    { history: [], said: "", results: {}, running: [], ...fields }, new AbortController().signal, () => true);
}
export const runVoiceHostTurn = (options: Omit<VoiceHostOptions, "snapshot"> & Pick<PresentationFields, "state" | "history" | "said"> & Partial<PresentationFields>) => host({ ...options, snapshot: fixturePresentation(options) });
export const runVoiceBrief = (options: Omit<VoiceBriefOptions, "snapshot"> & Pick<PresentationFields, "state" | "answer"> & Partial<PresentationFields>) => brief({ ...options, snapshot: fixturePresentation(options) });

import { CallSpeechCoordinator, type CallSpeechReady } from "../tts/call-coordinator.ts";
/** Synthetic complete engine sources enter through the same producer protocol as runtime. */
export function fixtureHostRoute(answer?: string, history: PresentationFields["history"] = []) {
  return (_req: unknown, threadId: string, botId: string, replyId?: string) => {
    const coordinator = new CallSpeechCoordinator(() => true);
    let ready: CallSpeechReady | undefined;
    coordinator.attach({ callId: "fixture-call", principal: "fixture-owner", threadId, targetId: botId }, {}, event => {
      if (event.type === "call.speech.ready") ready = event;
      return true;
    });
    if (replyId && answer !== undefined) {
      coordinator.begin(threadId, botId, "fixture-generation");
      coordinator.item(threadId, botId, "fixture-generation", "fixture-item", answer);
      coordinator.settle(threadId, botId, "fixture-generation", "fixture-message", true);
    }
    return { ...coordinator.openPresentation("fixture-call", "fixture-owner", threadId, botId, replyId ? ready?.replyId ?? replyId : undefined), history };
  };
}
