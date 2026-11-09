/** Authenticated call audio consumes a live sealed source exactly once. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { SpeechBudgetReached } from "./flux-speech.ts";
import type { Clip } from "./elevenlabs.ts";
import type { CallSpeechCoordinator } from "./call-coordinator.ts";
import { voicedText, type VoicedText } from "./speech-source.ts";

export interface CallReplyRouteDeps {
  readBody(): Promise<unknown>;
  principal(callId: string, threadId: string): string | null;
  speech: CallSpeechCoordinator;
  /** Speaks `text` exactly as given: it is already voicedText() output (production: tts speakCallClip). */
  synthesize(text: VoicedText, botId: string, signal: AbortSignal): Promise<Clip>;
}
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export async function handleCallReply(_req: IncomingMessage, res: ServerResponse, deps: CallReplyRouteDeps): Promise<void> {
  const error = (status: number) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ error: "call speech unavailable" })); };
  const body = await deps.readBody();
  if (!body || typeof body !== "object" || Array.isArray(body)) return error(400);
  const fields = body as Record<string, unknown>;
  const keys = ["callSessionId", "threadId", "replyId"] as const;
  if (Object.keys(fields).length !== keys.length || keys.some(key => typeof fields[key] !== "string" || !/^[\w-]{1,128}$/.test(fields[key]))) return error(400);
  const { callSessionId, threadId, replyId } = fields as Record<typeof keys[number], string>;
  const principal = deps.principal(callSessionId, threadId);
  if (!principal) return error(404);
  let job: ReturnType<CallSpeechCoordinator["claim"]>;
  try { job = deps.speech.claim(callSessionId, principal, threadId, replyId); } catch { return error(409); }
  const lost = () => job.close();
  const aborted = () => { if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify({ type: "failed" }) + "\n"); };
  res.once("close", lost);
  job.signal.addEventListener("abort", aborted, { once: true });
  const frame = async (value: unknown) => {
    job.signal.throwIfAborted();
    if (!job.current()) throw new Error("call speech unavailable");
    if (!res.write(JSON.stringify(value) + "\n")) await once(res, "drain", { signal: job.signal });
  };
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  try {
    for (const utterance of job.utterances) {
      job.signal.throwIfAborted();
      if (!job.current()) throw new Error("call speech unavailable");
      // One compilation: the voice is given exactly `voiced`, and the clip's caption below is its same text.
      const voiced = voicedText(utterance);
      const audio = await deps.synthesize(voiced, job.botId, job.signal);
      if (job.signal.aborted && "stream" in audio) await audio.stream.cancel().catch(() => {});
      job.signal.throwIfAborted();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if ("bytes" in audio) { chunks.push(audio.bytes); size = audio.bytes.byteLength; }
      else {
        const reader = audio.stream.getReader();
        const cancel = () => { void reader.cancel().catch(() => {}); };
        job.signal.addEventListener("abort", cancel, { once: true });
        try {
          for (;;) {
            job.signal.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > MAX_AUDIO_BYTES) throw new Error("audio limit");
            chunks.push(part.value);
          }
        } finally { job.signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      if (!size || size > MAX_AUDIO_BYTES) throw new Error("audio unavailable");
      // `text` is the exact string the voice was given for this clip (no later transformation), so the call screen
      // captions what it hears; it is never more than what is said aloud.
      await frame({ type: "clip", mime: audio.mime, data: Buffer.concat(chunks).toString("base64"), text: voiced.text });
      job.delivered(utterance);
    }
    await frame({ type: "complete" });
  } catch (error) {
    if (!job.signal.aborted && !res.destroyed) res.write(JSON.stringify({ type: "failed", ...(error instanceof SpeechBudgetReached ? { code: "voice_budget_reached" } : {}) }) + "\n");
  } finally {
    res.off("close", lost);
    job.signal.removeEventListener("abort", aborted);
    job.close();
    res.end();
  }
}
