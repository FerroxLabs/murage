/** The widths `?w=` accepts on the image routes, and the widths the client's
 *  srcset names (spec §6). A fixed set so thumbnails cache well and a client
 *  cannot ask for one per pixel. */
export const THUMBNAIL_WIDTHS = [320, 640, 1280] as const;
export type ThumbnailWidth = (typeof THUMBNAIL_WIDTHS)[number];
