// Hardenings from upstream #1587 (96ca9f4c) on Murage's own xAI speech.
import { describe, expect, it } from "vitest";
import { synthesize } from "./xai-speech.ts";

const endpoint = { baseUrl: "https://api.x.test/v1/", key: "xai-secret" };

function recorder(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const call = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, call };
}

describe("xAI speech", () => {
  it("asks for automatic language detection and refuses redirects", async () => {
    const { calls, call } = recorder(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
    const audio = await synthesize("Bonjour tout le monde", "ara", endpoint, call);
    expect(audio.bytes.byteLength).toBe(3);
    expect(calls[0]!.url).toBe("https://api.x.test/v1/tts");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "Bonjour tout le monde", voice_id: "ara", language: "auto" });
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it.each([
    [402, "Your xAI account is out of credits. Add credits with xAI, then try again."],
    [404, "xAI couldn't find that voice. Pick a different voice in Settings."],
    [401, "xAI rejected the saved key. Paste a fresh one in Settings."],
    [429, "xAI is rate-limiting this account. Wait a moment and try again."],
    [500, "Speaking failed (500)"],
  ])("says what a %s means in plain words, never echoing the body", async (status, message) => {
    const { call } = recorder(() => new Response("echo: xai-secret Bonjour", { status }));
    const failure = await synthesize("Bonjour", "eve", endpoint, call).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(message);
    expect((failure as Error).message).not.toContain("xai-secret");
  });
});
