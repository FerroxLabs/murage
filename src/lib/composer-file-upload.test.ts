// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ ensure: vi.fn(async () => "fixture-proof"), headers: vi.fn(() => ({ "x-murage-surface-secret": "fixture-proof" })) }));
vi.mock("./live-events.ts", () => ({ ensureDesktopSurfaceSecret: auth.ensure, desktopSurfaceHeaders: auth.headers }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("uses the existing surface proof for archive and XMind uploads and refuses redirects", async () => {
  const { fileAttachmentFromFile } = await import("./composer-file-upload.ts");
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ path: "/fixture/file.zip", name: "bundle.zip", bytes: 3 }), { status: 201 }));
  vi.stubGlobal("fetch", fetcher);
  await fileAttachmentFromFile(new File(["zip"], "bundle.zip"), () => "Could not attach this file.");
  expect(auth.ensure).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith("/api/files?name=bundle.zip", expect.objectContaining({
    method: "POST", redirect: "error", headers: { "content-type": "application/zip", "x-murage-surface": "desktop", "x-murage-surface-secret": "fixture-proof" },
  }));
});
