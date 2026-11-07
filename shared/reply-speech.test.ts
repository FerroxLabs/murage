import { expect, it } from "vitest";
import { ReplyFrameReader, replyFrame, MAX_REPLY_FRAME, type ReplyFrame } from "./reply-speech.ts";
const start: ReplyFrame = { type: "start", value: { attemptId: "attempt", revision: 1, mime: "audio/mpeg" } };
const bytes = (frames: ReplyFrame[]) => { const parts = frames.map(replyFrame), out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; };
it("S-drop accepts every byte partition only with exactly one successful terminal", () => {
  const frames: ReplyFrame[] = [start, { type: "audio", bytes: Uint8Array.of(255, 243, 68) }, { type: "complete" }]; const source = bytes(frames);
  for (let split = 0; split <= source.length; split++) {
    const seen: ReplyFrame[] = [], parser = new ReplyFrameReader(frame => seen.push(frame)); parser.push(source.slice(0, split)); parser.push(source.slice(split)); parser.finish(); expect(seen).toEqual(frames);
  }
  const seen: ReplyFrame[] = [], parser = new ReplyFrameReader(frame => seen.push(frame)); for (const byte of source) parser.push(Uint8Array.of(byte)); parser.finish(); expect(seen).toEqual(frames);
});
it("S-drop rejects clean EOF, playable partial audio, failed terminal, trailing bytes and duplicates", () => {
  const audio: ReplyFrame = { type: "audio", bytes: Uint8Array.of(255, 243, 68) };
  for (const frames of [[], [start], [start, audio], [start, audio, { type: "failed", code: "speech_failed" }], [audio], [start, start], [start, audio, { type: "complete" }, audio], [start, { type: "complete" }]] as ReplyFrame[][]) {
    expect(() => { const parser = new ReplyFrameReader(() => {}); parser.push(bytes(frames)); parser.finish(); }).toThrow();
  }
  const complete = bytes([start, audio, { type: "complete" }]);
  for (let at = 1; at < complete.length; at++) expect(() => { const parser = new ReplyFrameReader(() => {}); parser.push(complete.slice(0, at)); parser.finish(); }).toThrow();
});
it("rejects unapproved MIME, extra start fields and oversized frames before allocating their body", () => {
  for (const value of [{ ...start.value, mime: "text/html" }, { ...start.value, text: "untrusted" }, { ...start.value, revision: -1 }]) {
    expect(() => new ReplyFrameReader(() => {}).push(replyFrame({ type: "start", value }))).toThrow();
  }
  const header = new Uint8Array(5); header[0] = 2; new DataView(header.buffer).setUint32(1, MAX_REPLY_FRAME + 1);
  expect(() => new ReplyFrameReader(() => {}).push(header)).toThrow("speech_frame_size");
});
