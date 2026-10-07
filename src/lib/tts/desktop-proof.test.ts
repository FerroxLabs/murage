// The harness denies by default (server/route-policy.ts): a request to a
// conversation route that does not carry the desktop's per-launch proof is
// answered 404 {"error":"no such route"}. The voice routes the call screen
// uses were sent without it, so on the Mac every spoken reply, the instant
// cue and push-to-talk came back as that raw 404 body. 2026-10-04.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

async function speakerWithProof() {
  vi.resetModules();
  (globalThis as { muragebox?: unknown }).muragebox = { desktopSurfaceSecret: "proof-for-test" };
  const { Speaker } = await import("./index");
  return new Speaker();
}

describe("voice routes carry the desktop proof", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { muragebox?: unknown }).muragebox;
  });

  it("sends the proof on the clip request", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(["abc"]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    await (await speakerWithProof()).fetchClip("One sec.", { botId: "b" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-murage-surface"]).toBe("desktop");
    expect(headers["x-murage-surface-secret"]).toBe("proof-for-test");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("says a plain sentence, never the raw 404 body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "no such route" }), { status: 404 })));
    const failure = await (await speakerWithProof()).fetchClip("One sec.", { botId: "b" }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toMatch(/no such route/i);
    expect(message).not.toMatch(/\b404\b/);
    expect(message).toMatch(/voice/i);
    expect(message).not.toMatch(/—|safe/i);
  });

  it("still passes on the local server's own plain sentences", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Flux rejected the saved key. Paste a fresh one in Settings." }), { status: 502 })));
    await expect((await speakerWithProof()).fetchClip("One sec.", { botId: "b" })).rejects.toThrow("Flux rejected the saved key.");
  });

  it.each([
    "./index.ts",
    "./ack-cue.ts",
    "../call-mic.ts",
    "../dictation-cleanup.ts",
    "../../components/PushToTalk.tsx",
  ])("%s asks for the proof on every voice request", (file) => {
    const source = read(file);
    const fetches = source.match(/fetch(?:Impl)?\(\s*[`"]\/api\/(?:tts|voice)\//g) ?? [];
    const proofs = source.match(/desktopCallerHeaders\(\)/g) ?? [];
    expect(fetches.length).toBeGreaterThan(0);
    expect(proofs.length).toBeGreaterThanOrEqual(fetches.length);
  });
});
