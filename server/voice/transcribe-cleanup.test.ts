// `?cleanup=1` on the transcribe route: the phone and non-Mac surfaces get
// their dictation tidied in the same round trip. Calls never send it.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createVoiceBudget, handleTranscribeRoute } from "./transcribe-route.ts";

const RAW = "um so please tell Dana the report is uh ready";
const CLEAN = "Please tell Dana the report is ready.";

let server: Server;
let base = "";
let cleanup = vi.fn(async (text: string, _context?: unknown) => ({ text: CLEAN, cleaned: text === RAW }));

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    await handleTranscribeRoute(req.method ?? "GET", url, req, res, {
      transcribe: async () => ({ text: RAW, duration: 3, billedSeconds: 10 }),
      budget: createVoiceBudget(),
      cleanup: (text, context) => cleanup(text, context),
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (query = "") =>
  fetch(`${base}/api/voice/transcribe${query}`, {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: Object.assign(new Uint8Array(2048), [0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]),
  });

describe("transcribe with cleanup", () => {
  it("leaves the transcript raw when cleanup is not asked for (call turns)", async () => {
    cleanup.mockClear();
    const body = (await (await post()).json()) as Record<string, unknown>;
    expect(body.text).toBe(RAW);
    expect(body.raw).toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("returns the cleaned text and keeps the raw one when cleanup=1", async () => {
    cleanup.mockClear();
    const body = (await (await post("?cleanup=1&botId=bot_1")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ text: CLEAN, raw: RAW, cleaned: true });
    expect(cleanup).toHaveBeenCalledWith(RAW, { botId: "bot_1", groupId: undefined });
  });

  it("falls back to the raw text when cleanup throws", async () => {
    cleanup = vi.fn(async () => {
      throw new Error("model down");
    });
    const res = await post("?cleanup=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.text).toBe(RAW);
    expect(body.cleaned).toBe(false);
  });
});
