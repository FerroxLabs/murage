import "../shared/win-hide-child-process.mjs";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MAX_INPUT_PIXELS, rasterFormat } from "./image-thumbnail.ts";
import type { PanelAvatarEncode } from "./browser-extension-panel-avatar.ts";
export const PANEL_AVATAR_HELPER_IDLE_MS = 60_000;
interface SharpImage {
  metadata(): Promise<{ format?: string; width?: number; height?: number; pages?: number }>;
  rotate(): SharpImage;
  resize(options: { width: number; height: number; fit: "cover"; position: "centre" }): SharpImage;
  webp(options: { quality: number }): SharpImage;
  toBuffer(): Promise<Buffer>;
}
type Sharp = (input: Buffer, options: { limitInputPixels: number }) => SharpImage;

/** A PanelAvatarEncode over a sharp factory. Exported for its test, which passes a fake. Fail closed like sharpResize: the
 * magic number and sharp must agree, one frame only, and the header's size within the pixel limit before any decode. */
export function sharpPanelAvatar(sharp: Sharp): PanelAvatarEncode {
  return async (bytes, side) => {
    const sniffed = rasterFormat(bytes);
    if (!sniffed) return null;
    const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (meta.format !== sniffed || (meta.pages ?? 1) > 1) return null;
    if (!meta.width || !meta.height || meta.width * meta.height > MAX_INPUT_PIXELS) return null;
    return sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize({ width: side, height: side, fit: "cover", position: "centre" }).webp({ quality: 80 }).toBuffer();
  };
}


// Importing the resizer for unit tests does not start an IPC server.
if (process.send && /browser-extension-panel-avatar-encoder\.(?:ts|js)$/.test(process.argv[1] ?? '')) {
  let encode: PanelAvatarEncode | undefined;
  try {
    const sharp = createRequire(fileURLToPath(import.meta.resolve("@huggingface/transformers")))("sharp");
    sharp.cache(false); sharp.concurrency(1); encode = sharpPanelAvatar(sharp);
  } catch { /* Report unavailable, never a cacheable decode failure. */ }
  let idle: ReturnType<typeof setTimeout>;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), PANEL_AVATAR_HELPER_IDLE_MS); };
  arm();
  process.on('disconnect', () => process.exit(0));
  process.on('message', async (message: { id: number; bytes: Buffer; side: number }) => {
    clearTimeout(idle);
    if (process.env.MURAGE_PANEL_AVATAR_HELPER_HANG === '1') return;
    try {
      if (!encode) process.send?.({ id: message.id, unavailable: true });
      else process.send?.({ id: message.id, out: await encode(message.bytes, message.side) });
    } catch { process.send?.({ id: message.id, error: true }); }
    arm();
  });
}
