// POST /api/attachments is a conversation route: the harness refuses it with
// 404 no such route unless the desktop proof rides along. The avatar picker
// and the routine page upload without a thread, which used to skip the proof.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDesktopSurfaceSecretForTest } from "./live-events";
import { imageAttachmentFromFile } from "./composer-image-upload";

describe("image upload carries the desktop proof", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setDesktopSurfaceSecretForTest("");
  });

  it.each([[undefined], ["thread-1"]])("with thread %s", async (threadId) => {
    setDesktopSurfaceSecretForTest("proof-for-test");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ path: "/x/a.png", mime: "image/png", bytes: 3 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    await imageAttachmentFromFile(file, threadId);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-murage-surface"]).toBe("desktop");
    expect(headers["x-murage-surface-secret"]).toBe("proof-for-test");
  });
});
