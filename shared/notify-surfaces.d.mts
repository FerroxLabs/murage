export type NotifySurfaceId = "notify" | "receipt" | "tray" | "pill" | "badge" | "bubble" | "dock" | "shortcut";
export type NotifyOrigin = "new" | "upgrade";
export type NotifyChooserState = "unseen" | "done" | "kept-inside";
export interface NotifySurfaces {
  v: 1; origin: NotifyOrigin;
  surfaces: Record<NotifySurfaceId, boolean>;
  notifyActions: boolean; quietSummary: boolean; badgeMenu: boolean; badgeCount: "needs-you" | "unread";
  receiptMinMinutes: 0 | 2 | 5; nudgeMinutes: 0 | 5 | 15; hideFullscreen: boolean; respectFocus: boolean;
  pinnedBotId: string | null; shortcut: string | null; chooser: NotifyChooserState;
  asks: { backgroundApproval: boolean; longJob: boolean };
}
export const NOTIFY_SURFACES_VERSION: 1;
export const SURFACE_IDS: readonly NotifySurfaceId[];
export const ORIGINS: readonly NotifyOrigin[];
export const CHOOSER_STATES: readonly NotifyChooserState[];
export const MAX_FILE_BYTES: number;
export function notifySurfaceDefaults(origin: NotifyOrigin, platform: string): NotifySurfaces;
export function validAccelerator(value: unknown): boolean;
export function checkNotifySurfaceKey(key: string, value: unknown): { ok: true; value: unknown } | { ok: false };
export function normalizeNotifySurfaces(value: unknown, platform: string, fallbackOrigin?: NotifyOrigin): NotifySurfaces | null;
