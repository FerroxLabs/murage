// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { captureBrowserPreview } from "./browser-preview-capture.ts";

describe("browser preview capture", () => {
  it("requests JPEG at quality 80 and passes the image format through", async () => {
    const call = vi.fn().mockResolvedValue({ content: [
      { type: "text", text: "Picture" },
      { type: "image", data: "jpeg-bytes", mimeType: "image/jpeg" },
    ] });
    expect(await captureBrowserPreview(call)).toEqual({ png: "jpeg-bytes", format: "jpeg" });
    expect(call).toHaveBeenCalledWith({
      name: "agent_browser_screenshot", arguments: { format: "jpeg", quality: 80 },
    });
  });

  it("uses PNG when the engine returns PNG", async () => {
    const call = vi.fn().mockResolvedValue({ content: [{ type: "image", data: "png-bytes", mimeType: "image/png" }] });
    expect(await captureBrowserPreview(call)).toEqual({ png: "png-bytes", format: "png" });
  });

  it("reports WebP and jpg metadata as their true formats", async () => {
    expect(await captureBrowserPreview(async () => ({ content: [{ type: "image", data: "w", mimeType: "image/webp" }] })))
      .toEqual({ png: "w", format: "webp" });
    expect(await captureBrowserPreview(async () => ({ content: [{ type: "image", data: "j", mimeType: "image/jpg" }] })))
      .toEqual({ png: "j", format: "jpeg" });
  });

  it("keeps legacy images without format metadata as PNG", async () => {
    expect(await captureBrowserPreview(async () => ({ content: [{ type: "image", data: "legacy" }] })))
      .toEqual({ png: "legacy", format: "png" });
  });

  it("requires image content", async () => {
    await expect(captureBrowserPreview(async () => ({ content: [{ type: "text", text: "No picture" }] })))
      .rejects.toThrow("Browser picture is unavailable");
  });
});
