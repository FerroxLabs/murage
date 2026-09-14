// Browser-only authorization stays outside the shared attachment parser.
import { imageAttachmentFromFile as uploadImage } from "./composer-attachments.ts";
import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret } from "./live-events.ts";

export async function imageAttachmentFromFile(file: File, threadId?: string) {
  if (!threadId) return uploadImage(file);
  await ensureDesktopSurfaceSecret();
  return uploadImage(file, threadId, { "x-murage-surface": "desktop", ...desktopSurfaceHeaders() });
}
