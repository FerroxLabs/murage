// A screen message's pixels, fetched by route (E13): the ordinary paged
// fetch caps a phone to PHONE_SCREEN_FRAME_WIDTH, and fetchOriginalScreenFrame
// always asks for the `?w=`-free route so an enlarged view can show detail
// the capped bytes never carried. This pins which URL each one asks for; the
// bytes-to-base64 encoding and the enlarged-view swap are exercised by
// src/e2e/media-lightbox.human.spec.ts.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ ensure: vi.fn(), headers: vi.fn(() => ({ "x-murage-surface-secret": "synthetic-proof" })) }));
vi.mock("@/lib/live-events", () => ({ ensureDesktopSurfaceSecret: auth.ensure, desktopSurfaceHeaders: auth.headers }));

import { fetchOriginalScreenFrame } from "./paged-screen-frame";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  auth.ensure.mockReset().mockResolvedValue(undefined);
  fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(["bytes"], { type: "image/png" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("asks for the message's image route with no `w`, unlike the phone-capped paged fetch", async () => {
  const pixels = await fetchOriginalScreenFrame("t1", "m1");
  expect(fetchMock).toHaveBeenCalledWith("/api/threads/t1/messages/m1/image", { headers: { "x-murage-surface-secret": "synthetic-proof" } });
  expect(pixels?.mime).toBe("image/png");
});

it("returns null on a refused response, same as the capped fetch", async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect(await fetchOriginalScreenFrame("t1", "m1")).toBeNull();
});
