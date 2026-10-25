// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from upstream (Apache-2.0): JPEG settled-frame previews.

type ScreenshotCall = {
  name: "agent_browser_screenshot";
  arguments: { format: "jpeg"; quality: 80 };
};
type ScreenshotReply = {
  content?: { type: string; data?: string; mimeType?: string; format?: string }[];
};

/** MCP image metadata describes the bytes, including engines returning PNG. */
export async function captureBrowserPreview(call: (request: ScreenshotCall) => Promise<unknown>) {
  const reply = await call({ name: "agent_browser_screenshot", arguments: { format: "jpeg", quality: 80 } }) as ScreenshotReply;
  const image = reply.content?.find(item => item.type === "image" && item.data);
  if (!image?.data) throw new Error("Browser picture is unavailable");
  const raw = (image.mimeType?.split("/")[1] ?? image.format ?? "png").toLowerCase().split(";")[0]!.trim();
  return { png: image.data, format: raw === "jpg" ? "jpeg" : raw };
}
