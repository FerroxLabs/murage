import { describe, expect, it } from "vitest";
import { callAudioClips } from "./call-audio";
const stream = (text: string) => new ReadableStream<Uint8Array>({ start(controller) { for (const char of text) controller.enqueue(new TextEncoder().encode(char)); controller.close(); } });
const clip = JSON.stringify({ type: "clip", mime: "audio/mpeg", data: "AQID" }) + "\n";
describe("D24 framed call audio", () => {
  it("plays bounded complete clips across arbitrary frame partitions", async () => {
    const clips = [];
    for await (const blob of callAudioClips(stream(clip + '{"type":"complete"}\n'))) clips.push(new Uint8Array(await blob.arrayBuffer()));
    expect(clips).toEqual([new Uint8Array([1, 2, 3])]);
  });
  it.each([clip, clip + '{"type":"failed"}\n', '{"type":"complete"}\n' + clip, '{"type":"complete"}', '{"type":"clip","mime":"text/html","data":"AQID"}\n'])("fails an incomplete or malformed stream", async text => {
    await expect((async () => { for await (const _clip of callAudioClips(stream(text))) { /* consume */ } })()).rejects.toThrow();
  });
});
