import { beforeEach, describe, expect, it, vi } from "vitest";

import { Speaker } from "./index";

class FakeAudio {
  static latest: FakeAudio | null = null;

  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(async () => {});

  constructor(src: string) {
    this.src = src;
    FakeAudio.latest = this;
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Speaker lifecycle", () => {
  beforeEach(() => {
    FakeAudio.latest = null;
    vi.restoreAllMocks();
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("settles an in-progress speak when stop interrupts audio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["Hello there."] })
          : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("Hello there.");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());

    speaker.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(FakeAudio.latest!.pause).toHaveBeenCalled();
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("aborts preparation when stopped instead of leaving a request alive", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("A long response");

    speaker.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("passes a per-bot voice through preparation and synthesis", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["Distinct voice."] })
          : new Response(new Blob(["mp3"]), { status: 200 });
      }),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("Distinct voice.", { voiceId: "voice-bot" });
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());
    FakeAudio.latest!.onended?.();
    await speaking;

    expect(bodies).toEqual([
      { text: "Distinct voice.", voiceId: "voice-bot" },
      { text: "Distinct voice.", voiceId: "voice-bot" },
    ]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-test");
  });

  it("streams pushed sentences in order and reports that all were heard", async () => {
    const spoken: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        spoken.push(JSON.parse(String(init?.body)).text);
        return new Response(new Blob(["mp3"]), { status: 200 });
      }),
    );
    const speaker = new Speaker();
    const stream = speaker.stream({ voiceId: "v" });
    stream.push("Let me look into that.");
    await vi.waitFor(() => expect(speaker.state.caption).toBe("Let me look into that."));
    stream.push("It is running now.");
    FakeAudio.latest!.onended?.();
    await vi.waitFor(() => expect(speaker.state.caption).toBe("It is running now."));
    stream.end();
    FakeAudio.latest!.onended?.();
    await expect(stream.done).resolves.toBe(true);
    expect(spoken).toEqual(["Let me look into that.", "It is running now."]);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("settles a stream that is waiting for its next sentence when stopped", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["mp3"]), { status: 200 })));
    const speaker = new Speaker();
    const stream = speaker.stream();
    speaker.stop();
    await expect(stream.done).resolves.toBe(false);
    stream.push("too late");
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("an ended stream with nothing pushed finishes at once", async () => {
    const speaker = new Speaker();
    const stream = speaker.stream();
    stream.end();
    await expect(stream.done).resolves.toBe(true);
  });
});
