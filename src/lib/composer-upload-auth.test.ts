import { afterEach, expect, it, vi } from "vitest";
import { imageAttachmentFromFile } from "./composer-image-upload.ts";

const auth = vi.hoisted(() => ({ ensure: vi.fn(async () => "synthetic-surface"), headers: vi.fn(() => ({ "x-murage-surface-secret": "synthetic-surface" })) }));
vi.mock("./live-events.ts", () => ({ ensureDesktopSurfaceSecret: auth.ensure, desktopSurfaceHeaders: auth.headers }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("sends desktop proof only to the same-origin thread-bound image upload", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ path: "/fixture/image.png", mime: "image/png", bytes: 3 })));
  vi.stubGlobal("fetch", fetcher);
  const file = { name: "image.png", type: "image/png", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as File;
  await imageAttachmentFromFile(file, "original/thread");
  expect(auth.ensure).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith("/api/attachments?threadId=original%2Fthread", expect.objectContaining({
    method: "POST", headers: { "content-type": "image/png", "x-murage-surface": "desktop", "x-murage-surface-secret": "synthetic-surface" },
  }));
});

it("leaves legacy unbound uploads unchanged without claiming thread authority", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ path: "/fixture/image.png", mime: "image/png", bytes: 3 })));
  vi.stubGlobal("fetch", fetcher);
  const file = { name: "image.png", type: "image/png", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as File;
  await imageAttachmentFromFile(file);
  expect(auth.ensure).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledWith("/api/attachments", expect.objectContaining({ headers: { "content-type": "image/png" } }));
});
