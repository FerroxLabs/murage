import { z } from "zod";

/** The mascot is a first-class avatar choice; the other values crop an image. */
export const BOT_AVATAR_CROPS = ["mascot", "circle", "rounded", "square"] as const;
export const botAvatarCropSchema = z.enum(BOT_AVATAR_CROPS);
export type BotAvatarCrop = z.infer<typeof botAvatarCropSchema>;

/**
 * Custom avatars are deliberately limited to this app's attachment server.
 * Besides making persisted profiles portable across desktop/browser clients,
 * this prevents a bot profile from becoming an external tracking pixel or a
 * script-capable SVG.
 */
export const botAvatarUrlSchema = z
  .string()
  .regex(
    /^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|gif|webp)$/,
    "must be a stored PNG, JPEG, GIF, or WebP attachment",
  );

export function botAvatarUrlFromStoredPath(path: string): string | null {
  const name = path.replaceAll("\\", "/").split("/").pop();
  if (!name) return null;
  const url = `/api/attachments/${name}`;
  return botAvatarUrlSchema.safeParse(url).success ? url : null;
}

/** Runtime-safe defaults for untrusted persisted/SSE profile data. */
export interface BotAvatarProfileInput {
  avatarUrl?: unknown;
  avatarCrop?: unknown;
}

export interface BotAvatarProfile {
  avatarUrl?: string;
  avatarCrop: BotAvatarCrop;
}

export function botAvatarProfile(value: BotAvatarProfileInput): BotAvatarProfile {
  const profile: BotAvatarProfile = {
    avatarCrop: botAvatarCropSchema.safeParse(value.avatarCrop).data ?? "mascot",
  };
  const url = botAvatarUrlSchema.safeParse(value.avatarUrl);
  if (url.success) profile.avatarUrl = url.data;
  return profile;
}

/** 1 shows the picture as a cover crop; larger values zoom in. */
export const AVATAR_ZOOM_MIN = 1;
export const AVATAR_ZOOM_MAX = 3;
/** Where the crop sits on the picture, from 0 to 1 on each axis: 0 the left
 *  or top edge, 0.5 the centre, 1 the right or bottom edge. Zoom keeps that
 *  point where it is in the tile. */
export const AVATAR_FOCUS_CENTER = 0.5;

export function clampAvatarZoom(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return AVATAR_ZOOM_MIN;
  return Math.round(Math.min(AVATAR_ZOOM_MAX, Math.max(AVATAR_ZOOM_MIN, parsed)) * 100) / 100;
}

export function clampAvatarFocus(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return AVATAR_FOCUS_CENTER;
  return Math.round(Math.min(1, Math.max(0, parsed)) * 1000) / 1000;
}

/** How a custom picture is framed everywhere the bot's image appears: the
 *  same zoom and point, so Settings, the sidebar and a call all match.
 *  Untrusted input is clamped; nothing set means the plain cover crop. */
export function avatarFraming(value: { avatarZoom?: unknown; avatarFocusX?: unknown; avatarFocusY?: unknown }): { objectPosition: string; transform?: string; transformOrigin?: string } {
  const zoom = clampAvatarZoom(value.avatarZoom ?? AVATAR_ZOOM_MIN);
  const origin = `${clampAvatarFocus(value.avatarFocusX ?? AVATAR_FOCUS_CENTER) * 100}% ${clampAvatarFocus(value.avatarFocusY ?? AVATAR_FOCUS_CENTER) * 100}%`;
  return zoom === AVATAR_ZOOM_MIN ? { objectPosition: origin } : { objectPosition: origin, transform: `scale(${zoom})`, transformOrigin: origin };
}
