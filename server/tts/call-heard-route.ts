/** Authenticated playback counts reconcile server-owned call history. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CallHeardReport, CallSpeechCoordinator } from "./call-coordinator.ts";

export interface CallHeardRouteDeps {
  readBody(): Promise<unknown>;
  principal(callId: string, threadId: string): string | null;
  speech: CallSpeechCoordinator;
}
export async function handleCallHeard(_req: IncomingMessage, res: ServerResponse, deps: CallHeardRouteDeps): Promise<void> {
  const error = (status: number) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ error: "call speech unavailable" })); };
  const body = await deps.readBody();
  if (!body || typeof body !== "object" || Array.isArray(body)) return error(400);
  const fields = body as Record<string, unknown>;
  const keys = ["callSessionId", "threadId", "replyId"] as const;
  if (Object.keys(fields).length !== 6 || keys.some(key => typeof fields[key] !== "string" || !/^[\w-]{1,128}$/.test(fields[key]))
    || !Number.isInteger(fields.ended) || (fields.ended as number) < 0 || (fields.ended as number) > 1000
    || typeof fields.cut !== "boolean" || typeof fields.cutIn !== "boolean") return error(400);
  const { callSessionId, threadId, replyId, ended, cut, cutIn } = fields as Record<typeof keys[number], string> & CallHeardReport;
  const principal = deps.principal(callSessionId, threadId);
  if (!principal) return error(404);
  try { deps.speech.reportHeard(callSessionId, principal, threadId, replyId, { ended, cut, cutIn }); } catch { return error(409); }
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}
