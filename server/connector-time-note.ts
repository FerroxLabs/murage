// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.8 dry run (TRIAGE.md a, g): a calendar's free/busy answer lists busy
// times in UTC ("2026-10-27T19:00:00Z"), and the bot read 19:00 as the
// owner's 7 pm, then booked holds on top of busy events. The app's answer is
// right; it is simply in another zone than the owner's.
//
// Like the missing-permission note (connector-scope-hint.ts), this adds one
// text block to the tool result at the reply boundary, and only when the
// answer holds a time stamped with an offset that is not the owner's at that
// moment. The app's own text is untouched and the journal keeps the raw
// answer. It is plain text in the tool result, so every engine reads it the
// same way. Times with no offset at all ("2026-11-10T09:00:00") are left
// alone: what zone they mean is the app's to say, not ours to guess.
import { daylightSavingNote, utcOffsetLabel, utcOffsetMinutes } from "./owner-time-zone.ts";

// An offset is read only where it cannot be the end of a time range: after a T time ("2026-10-27T19:00Z",
// "2026-10-27T09:00:00-05:00") or after a spaced time with seconds ("2026-10-27 19:00:00Z"). A calendar list's
// "2026-10-27 09:00-10:00 Standup" is a range from 09:00 to 10:00 in the app's own zone, not a -10:00 offset.
const STAMP = /\b(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,9})?)?| (\d{2}):(\d{2}):\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}:?\d{2})\b/g;
/** No zone on Earth is further than 14 hours from UTC: anything bigger is not an offset. */
const MAX_OFFSET_MINUTES = 14 * 60;
/** Bigger answers are passed on as they are: scanning them costs more than the note is worth. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
/** More stamps than this and the answer is passed on with no note: a list that long is not worth the scan. */
const MAX_STAMPS = 500;

function stampOffset(zone: string): number {
  if (zone === "Z") return 0;
  const sign = zone[0] === "-" ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
}

/** Whether a text holds a time stamped in an offset the owner's zone does not have at that instant. */
export function hasForeignTimes(text: string, timeZone: string): boolean {
  let seen = 0;
  for (const match of text.matchAll(STAMP)) {
    if (++seen > MAX_STAMPS) return false;
    const zone = match[6]!, hour = match[2] ?? match[4], minute = match[3] ?? match[5];
    const offset = stampOffset(zone);
    if (Math.abs(offset) > MAX_OFFSET_MINUTES) continue;
    const at = Date.parse(`${match[1]}T${hour}:${minute}:00${zone === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`}`);
    if (!Number.isFinite(at)) continue;
    try { if (offset !== utcOffsetMinutes(at, timeZone)) return true; } catch { return false; }
  }
  return false;
}

/** The note a bot reads under such an answer. */
export function foreignTimesNote(timeZone: string, now: number = Date.now()): string {
  const dst = daylightSavingNote(now, timeZone);
  return `Note from Murage: some times in this answer are in another zone than the owner's (a trailing Z means UTC). `
    + `The owner's time zone is ${timeZone}, ${utcOffsetLabel(now, timeZone)} now.${dst ? ` ${dst}` : ""} `
    + "Convert each time to the owner's zone before you state it, compare it with another or book around it.";
}

type Frame = { result?: { content?: unknown } };

function annotateFrame(frame: unknown, timeZone: string, now: number): boolean {
  const result = (frame as Frame | null)?.result;
  if (!result || !Array.isArray(result.content)) return false;
  const foreign = result.content.some((item) =>
    item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
    && hasForeignTimes((item as { text: string }).text, timeZone));
  if (!foreign) return false;
  result.content.push({ type: "text", text: foreignTimesNote(timeZone, now) });
  return true;
}

/** The relayed MCP response with the note added once, on the last frame whose tool result holds such a time. Anything else, including a
 *  body it cannot read, comes back byte for byte (the same Uint8Array). */
export function withForeignTimesNote(bytes: Uint8Array, contentType: string, timeZone: string, now: number = Date.now()): Uint8Array {
  if (bytes.byteLength > MAX_SCAN_BYTES) return bytes;
  const text = new TextDecoder().decode(bytes);
  STAMP.lastIndex = 0;
  if (!STAMP.test(text)) return bytes;
  STAMP.lastIndex = 0;
  try {
    if (/text\/event-stream/i.test(contentType) || /^data:/m.test(text)) {
      const lines = text.split("\n");
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index]!;
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw.startsWith("{")) continue;
        const frame = JSON.parse(raw);
        if (!annotateFrame(frame, timeZone, now)) continue;
        lines[index] = `data: ${JSON.stringify(frame)}${line.endsWith("\r") ? "\r" : ""}`;
        return new TextEncoder().encode(lines.join("\n"));
      }
      return bytes;
    }
    const frame = JSON.parse(text);
    return annotateFrame(frame, timeZone, now) ? new TextEncoder().encode(JSON.stringify(frame)) : bytes;
  } catch {
    return bytes;
  }
}
