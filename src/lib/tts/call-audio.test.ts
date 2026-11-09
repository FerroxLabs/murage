import { describe, expect, it } from "vitest";
import { callAudioClips } from "./call-audio";
const stream = (text: string) => new ReadableStream<Uint8Array>({ start(controller) { for (const char of text) controller.enqueue(new TextEncoder().encode(char)); controller.close(); } });
const clip = JSON.stringify({ type: "clip", mime: "audio/mpeg", data: "AQID", text: "Hello there." }) + "\n";
describe("D24 framed call audio", () => {
  it("plays bounded complete clips across arbitrary frame partitions", async () => {
    const clips = [], captions = [];
    for await (const played of callAudioClips(stream(clip + '{"type":"complete"}\n'))) { clips.push(new Uint8Array(await played.audio.arrayBuffer())); captions.push(played.text); }
    expect(clips).toEqual([new Uint8Array([1, 2, 3])]);
    expect(captions).toEqual(["Hello there."]);
  });
  it("keeps a long caption with no spaces whole, as the server releases it", async () => {
    const long = "x".repeat(10_000), captions = [];
    for await (const played of callAudioClips(stream(JSON.stringify({ type: "clip", mime: "audio/mpeg", data: "AQID", text: long }) + '\n{"type":"complete"}\n'))) captions.push(played.text);
    expect(captions).toEqual([long]);
  });
  it.each(['{"type":"clip","mime":"audio/mpeg","data":"AQID"}\n{"type":"complete"}\n', JSON.stringify({ type: "clip", mime: "audio/mpeg", data: "AQID", text: 7 }) + '\n{"type":"complete"}\n'])("fails a clip without a caption", async text => {
    await expect((async () => { for await (const _clip of callAudioClips(stream(text))) { /* consume */ } })()).rejects.toThrow();
  });
  it.each([clip, clip + '{"type":"failed"}\n', '{"type":"complete"}\n' + clip, '{"type":"complete"}', '{"type":"clip","mime":"text/html","data":"AQID"}\n'])("fails an incomplete or malformed stream", async text => {
    await expect((async () => { for await (const _clip of callAudioClips(stream(text))) { /* consume */ } })()).rejects.toThrow();
  });
});
