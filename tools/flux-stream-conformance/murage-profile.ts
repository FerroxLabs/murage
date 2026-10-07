// CallView's end-of-turn rules replayed on one timeline (spec E.4). The rules
// are imported, not copied: soundsUnfinished and the hold's timings from
// HeldLine, and joinsTurn as CallView's joinTurn applies it. Receipt times of
// a conformance run stand in for the phone's clock; the host's first audio is
// modelled `hostFirstAudioMs` after a send.
import { CALL_ENDPOINT_LONG_MS, CONTINUATION_CAP_MS, CONTINUATION_WAIT_MS, joinsTurn, soundsUnfinished } from "../../src/lib/call-turns.ts";

export type ProfileEvent = { at: number; kind: "start" } | { at: number; kind: "line"; text: string; endedAt?: number };

export interface ProfileResult {
  ownerTurns: string[];
  sends: number;
  /** Lines that joined a turn already sent (that host turn was thrown away). */
  superseded: number;
  /** Of those, joins that came after the reply had started playing before the owner went on. */
  audibleRestarts: number;
}

const CHECK_MS = 100;

export function replayCallTurns(events: ProfileEvent[], opts: { hostFirstAudioMs?: number; streamHoldMs?: number } = {}): ProfileResult {
  const hostFirstAudioMs = opts.hostFirstAudioMs ?? 3500;
  // StreamMic's continuation window after a line that sounds unfinished: at
  // least as pause-tolerant as CallView's long endpoint
  const streamHoldMs = opts.streamHoldMs ?? CALL_ENDPOINT_LONG_MS;
  const result: ProfileResult = { ownerTurns: [], sends: 0, superseded: 0, audibleRestarts: 0 };
  // widened with `as`: both change inside the closures below, which TypeScript's
  // narrowing of a `let` initialised to null does not see
  let held = null as { text: string; since: number; nextCheck: number; streamUntil: number } | null;
  let lastSend = null as { text: string; sentAt: number; playingAt: number } | null;
  let utteranceBegan = 0; // CallView's utteranceBegan: the first sign of the utterance now being heard
  const send = (text: string, at: number) => {
    result.ownerTurns.push(text);
    result.sends += 1;
    lastSend = { text, sentAt: at, playingAt: at + hostFirstAudioMs };
  };
  // HeldLine's "more is coming": speech begun at or after `since`, its line not in yet
  const pending = (since: number) => utteranceBegan !== 0 && utteranceBegan >= since;
  const runTimers = (until: number) => {
    while (held && held.nextCheck <= until) {
      const now = held.nextCheck;
      if ((pending(held.since) || now < held.streamUntil) && now - held.since < CONTINUATION_CAP_MS) {
        held.nextCheck = now + CHECK_MS;
        continue;
      }
      const text = held.text;
      held = null;
      send(text, now);
    }
  };
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    runTimers(e.at);
    if (e.kind === "start") {
      if (!utteranceBegan) utteranceBegan = e.at;
      continue;
    }
    const began = utteranceBegan;
    utteranceBegan = 0;
    let said = e.text;
    // joinTurn: the rest of the turn in flight
    if (lastSend) {
      const playingAt = lastSend.playingAt <= e.at ? lastSend.playingAt : null;
      if (joinsTurn({ sentAt: lastSend.sentAt, playingAt }, { began, now: e.at })) {
        result.superseded += 1;
        if (playingAt !== null && playingAt < (began || e.at)) result.audibleRestarts += 1;
        result.ownerTurns.pop();
        said = `${lastSend.text} ${said}`;
        lastSend = null;
      }
    }
    // HeldLine.take
    const text = held ? `${held.text} ${said}` : said;
    held = null;
    if (!soundsUnfinished(text)) {
      send(text, e.at);
      continue;
    }
    const since = Math.min(e.endedAt ?? e.at, e.at);
    held = { text, since, nextCheck: e.at + CONTINUATION_WAIT_MS, streamUntil: soundsUnfinished(said) ? since + streamHoldMs : 0 };
  }
  runTimers(Number.POSITIVE_INFINITY);
  return result;
}
