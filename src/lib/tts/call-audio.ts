/** Bounded framed audio. EOF without the server's terminal frame is a failure. */
export interface CallReplyId { callSessionId: string; threadId: string; replyId: string }
export class CallAudioBudgetReached extends Error {}
const MAX_FRAME = 6 * 1024 * 1024;
/** One framed clip: its audio and the exact text the voice was given for it (the call screen's caption). The
 *  caption is bounded by the frame (MAX_FRAME), as the server's utterances are: a long word has no break to split at. */
export interface CallAudioClip { audio: Blob; text: string }
export async function* callAudioClips(body: ReadableStream<Uint8Array>): AsyncGenerator<CallAudioClip> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", complete = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > MAX_FRAME) throw new Error("call audio limit");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        if (complete) throw new Error("call audio after completion");
        const frame = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
        buffer = buffer.slice(end + 1);
        if (frame.type === "failed" && frame.code === "voice_budget_reached") throw new CallAudioBudgetReached();
        if (frame.type === "complete") { complete = true; continue; }
        if (frame.type !== "clip" || typeof frame.mime !== "string" || !/^audio\/[a-z0-9.+-]+$/i.test(frame.mime) || typeof frame.data !== "string" || !frame.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data) || typeof frame.text !== "string") throw new Error("call audio failed");
        const decoded = atob(frame.data);
        if (decoded.length > 4 * 1024 * 1024) throw new Error("call audio limit");
        yield { audio: new Blob([Uint8Array.from(decoded, char => char.charCodeAt(0))], { type: frame.mime }), text: frame.text };
      }
    }
    if (!complete || buffer || decoder.decode()) throw new Error("incomplete call audio");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
