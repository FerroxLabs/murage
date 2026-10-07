// Browser-only authorization stays outside the shared attachment parser.
import { imageAttachmentFromFile as uploadImage } from "./composer-attachments.ts";
import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret } from "./live-events.ts";

export async function imageAttachmentFromFile(file: File, threadId?: string) {
  // POST /api/attachments is a conversation route: without the proof it is
  // answered 404 no such route, with or without a thread.
  await ensureDesktopSurfaceSecret();
  return uploadImage(file, threadId, { "x-murage-surface": "desktop", ...desktopSurfaceHeaders() });
}
