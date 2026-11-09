import type { ServerResponse } from "node:http";
import { once } from "node:events";
import { AUDIO_MIMES, MAX_REPLY_AUDIO, MAX_REPLY_FRAME, REPLY_AUDIO_MIME, replyFrame } from "../../shared/reply-speech.ts";
import { SpeechBudgetReached } from "./flux-speech.ts";
import { ProviderBudgetReached } from "./speech-policy.ts";
import { SpeechRefusal, type SpeechConnection } from "./reply-state.ts";
import { ReplyCoordinator, type ReplyJob } from "./reply-coordinator.ts";
export interface ReplyRouteDeps {
  principal: string | null;
  readBody(): Promise<unknown>;
  connection(id: string): SpeechConnection | undefined;
  ownerThread(threadId: string): boolean;
  coordinator: ReplyCoordinator;
}
/** Handler gate is independent of route policy. The caller supplies only a proven desktop principal. */
export async function handleReplyRoute(path: string, res: ServerResponse, deps: ReplyRouteDeps): Promise<void> {
  const send = (status: number, value?: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
  const { coordinator: coordinator } = deps, state = coordinator.state;
  let job: ReplyJob | undefined;
  let started = false, terminal = false;
  let targetIdentity: { threadId: string; messageId: string } | undefined;
  const request = new AbortController();
  const lost = () => { request.abort(); if (job) { try { coordinator.finish(job, "cancelled"); } catch { /* no successful terminal */ } } };
  res.once("close", lost);
  try {
    if (!deps.principal) throw new SpeechRefusal(403, "desktop_required");
    const value = await deps.readBody();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpeechRefusal(400, "invalid_body");
    const body = value as Record<string, unknown>;
    const suffix = path.slice("/api/tts/reply".length);
    const fields = suffix === "/session" ? ["connectionId", "threadId"] : suffix === "/target" ? ["sessionId", "threadId", "messageId"] : suffix === "/cancel" ? ["sessionId", "commandSequence", "threadId"] : suffix === "" ? ["sessionId", "commandSequence", "threadId", "messageId", body.action === "speak" ? "action" : "settlementId"] : [];
    if (!fields.length || Object.keys(body).length !== fields.length || fields.some(key => key === "commandSequence" ? !Number.isSafeInteger(body[key]) || Number(body[key]) <= 0 : typeof body[key] !== "string" || !/^[\w-]{1,128}$/.test(body[key] as string))) throw new SpeechRefusal(400, "invalid_body");
    const threadId = body.threadId as string;
    if (!deps.ownerThread(threadId)) throw new SpeechRefusal(404, "reply_unavailable");
    if (suffix === "/session") {
      const connection = deps.connection(body.connectionId as string);
      if (!connection || connection.principal !== deps.principal) throw new SpeechRefusal(409, "session_unavailable");
      return send(200, state.session(connection, threadId));
    }
    const sessionId = body.sessionId as string;
    const connectionId = state.binding(sessionId, deps.principal, threadId);
    if (suffix === "/target") return send(200, coordinator.metadata(threadId, body.messageId as string));
    const input = { sessionId, principal: deps.principal, connectionId, threadId, commandSequence: body.commandSequence as number, messageId: body.messageId as string, ...(body.action === "speak" ? { action: "speak" as const } : { settlementId: body.settlementId as string }) };
    if (suffix === "/cancel") { state.cancel(input); return send(204); }
    targetIdentity = { threadId, messageId: input.messageId };
    job = await coordinator.launch(input, request.signal) ?? undefined;
    if (!job) return send(204);
    const current = () => { if (!job || request.signal.aborted || !coordinator.current(job) || !deps.ownerThread(threadId)) throw new SpeechRefusal(409, "attempt_cancelled"); };
    current();
    const clip = await job.audio;
    current();
    if (!AUDIO_MIMES.has(clip.mime)) throw new Error("speech_mime");
    res.writeHead(200, { "content-type": REPLY_AUDIO_MIME, "cache-control": "no-store" }); started = true;
    const write = async (bytes: Uint8Array) => { current(); if (!res.write(bytes)) await once(res, "drain", { signal: job!.controller.signal }); current(); };
    await write(replyFrame({ type: "start", value: { attemptId: job.attempt.attemptId, revision: job.attempt.revision, mime: clip.mime } }));
    let total = 0;
    const audio = async (bytes: Uint8Array) => {
      total += bytes.byteLength; if (total > MAX_REPLY_AUDIO) throw new Error("speech_audio_limit");
      for (let offset = 0; offset < bytes.length; offset += MAX_REPLY_FRAME) await write(replyFrame({ type: "audio", bytes: bytes.subarray(offset, offset + MAX_REPLY_FRAME) }));
    };
    if ("bytes" in clip) await audio(clip.bytes);
    else {
      const reader = clip.stream.getReader();
      const abort = () => { void reader.cancel().catch(() => {}); };
      job.controller.signal.addEventListener("abort", abort, { once: true });
      try { for (;;) { current(); const part = await reader.read(); current(); if (part.done) break; await audio(part.value); } }
      finally { job.controller.signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    current(); if (!total) throw new Error("speech_empty_audio");
    coordinator.finish(job, "complete");
    terminal = true; res.end(replyFrame({ type: "complete" }));
  } catch (error) {
    const budget = error instanceof ProviderBudgetReached || error instanceof SpeechBudgetReached || error instanceof SpeechRefusal && error.status === 402;
    if (job) { try { coordinator.finish(job, budget ? "budget" : request.signal.aborted || job.controller.signal.aborted ? "cancelled" : "failed"); } catch { /* unresolved durable attempts are held on boot */ } }
    if (!res.destroyed && !res.writableEnded) {
      if (started) { if (!terminal) res.end(replyFrame({ type: "failed", code: "speech_failed" })); }
      else {
        let metadata: unknown;
        if (budget && targetIdentity && !job) { try { metadata = coordinator.metadata(targetIdentity.threadId, targetIdentity.messageId); } catch { /* fixed refusal */ } }
        if (budget && job) { try { metadata = state.accountStatus(job.attempt.accountScopeId, job.attempt.planVersion); } catch { /* fixed refusal */ } }
        send(budget ? 402 : error instanceof SpeechRefusal ? error.status : 502, { error: budget ? "voice_budget_reached" : error instanceof SpeechRefusal ? error.code : "speech_failed", ...(metadata ?? {}) });
      }
    }
  } finally { res.off("close", lost); }
}
