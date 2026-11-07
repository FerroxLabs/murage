import { useSyncExternalStore } from "react";
import { desktopCallerHeaders } from "../live-events";
import { knownComputer } from "../surface";
import { useSpeech } from "./useSpeech";
import { ReplyController } from "./reply-controller";
export const SPOKEN_REPLIES_KEY = "murage-spoken-replies";
const enabled = () => { try { return globalThis.localStorage?.getItem(SPOKEN_REPLIES_KEY) === "true"; } catch { return false; } };
export const replyController = new ReplyController({
  enabled: enabled(),
  saveEnabled: value => { try { globalThis.localStorage?.setItem(SPOKEN_REPLIES_KEY, String(value)); } catch { /* private browsing keeps this session's choice */ } },
  post: (path, body, signal) => fetch(path, { method: "POST", redirect: "error", headers: { "content-type": "application/json", ...desktopCallerHeaders() }, body: JSON.stringify(body), signal }),
  player: (blob, ended, failed) => {
    const url = URL.createObjectURL(blob), audio = new Audio(url); let closed = false;
    audio.onended = ended; audio.onerror = failed;
    return { play: () => audio.play(), stop: () => { if (closed) return; closed = true; audio.onended = null; audio.onerror = null; audio.pause(); audio.removeAttribute("src"); audio.load(); URL.revokeObjectURL(url); } };
  },
});
export function useReplySpeech() { return useSyncExternalStore(replyController.subscribe, () => replyController.snapshot, () => replyController.snapshot); }
/** Desktop controls share reply ownership; the retained phone controls share their legacy Speaker. */
export function useReadAloudSpeech() {
  const reply = useReplySpeech(), phone = useSpeech();
  return knownComputer() === true ? { status: reply.status === "fetching" ? "preparing" : reply.status === "waiting-for-player-end" ? "speaking" : "idle", messageId: reply.messageId, threadId: reply.threadId } : phone;
}
