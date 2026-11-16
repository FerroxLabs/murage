// SPDX-License-Identifier: AGPL-3.0-or-later
// Composing the cached start-up picture (FIRSTRUN-1019 section 2.2, contract K2): the Chief's face twice (image A at rest, image B
// looking up) as standalone SVG, plus the next tip in the Chief's words. Main validates and writes it (electron/startup-picture.mjs);
// the next start's splash embeds each face as an <img> data URI. Pure functions and injected dependencies, so every step is testable
// without a browser; the real drawing lives in src/components/StartupPictureWriter.tsx.
import { desktopCallerHeaders } from "./live-events";
import { faceRow } from "./face-row";
import { botAvatarProfile, clampAvatarFocus, clampAvatarZoom, AVATAR_FOCUS_CENTER, AVATAR_ZOOM_MIN, type BotAvatarCrop } from "../../shared/bot-avatar";
import { nextTipIndex, pickTipIndex, STARTUP_TIP_IDS, tipText, type TipBot, type TipOs } from "./startup-tips";
import type { TipStrings } from "../locales/startup-tips";

/** The photo is saved at most this many pixels on a side: a face that shows at 30 px never needs more. */
export const PHOTO_PX = 96;
/** The face is drawn in a 30 by 30 tile, the splash's mark height for a tip. */
export const FACE_PX = 30;
export const PICTURE_VERSION = 1;
/** Where the roster row starts giving way, in characters of the whole picture (the file limit is 192 KiB). */
const TEAM_BUDGET_CHARS = 150_000;

const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface FaceBot extends TipBot {
  color?: string;
  mascotBody?: string | null;
  avatarUrl?: string | null;
  avatarCrop?: BotAvatarCrop;
  avatarZoom?: number;
  avatarFocusX?: number;
  avatarFocusY?: number;
}
export type FaceState = "idle" | "happy";
export interface LoadedPhoto { dataUri: string; width: number; height: number }

export interface StartupPicturePayload {
  v: 1;
  tipNext: number;
  faceA: string;
  faceB: string;
  /** The person's own roster for the daily start: the first teammates' real faces (resting) and how many more there are. */
  team?: { faces: string[]; more: number };
  tip: { id: string; head: string; line: string; try: string };
  at: number;
}

/** An SVG as a picture on its own: the namespace set, and every id given a face prefix (references updated) so no two ids collide
 * and nothing points outside the file. null when the markup is not an <svg>. */
export function standaloneSvg(markup: string, prefix: string): string | null {
  if (typeof markup !== "string" || !/^\s*<svg[\s>]/i.test(markup)) return null;
  let svg = markup.trim();
  if (!/^<svg[^>]*\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(svg)) svg = svg.replace(/^<svg/i, `<svg xmlns="${SVG_NS}"`);
  if (/xlink:/.test(svg) && !/xmlns:xlink=/.test(svg)) svg = svg.replace(/^<svg/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  const ids = new Set<string>();
  for (const match of svg.matchAll(/\sid="([^"]*)"/g)) ids.add(match[1]);
  const renamed = (id: string) => `${prefix}-${id}`;
  svg = svg.replace(/(\sid=")([^"]*)(")/g, (_all, open: string, id: string, close: string) => `${open}${renamed(id)}${close}`);
  svg = svg.replace(LOCAL_PAINT_REF, (all, quote: string, id: string) => (ids.has(id) ? `${PAINT_FN}${quote}#${renamed(id)}${quote})` : all));
  svg = svg.replace(/((?:xlink:)?href=")#([^"]*)(")/g, (all, open: string, id: string, close: string) => (ids.has(id) ? `${open}#${renamed(id)}${close}` : all));
  return svg;
}

/** The size a picture shrinks to so neither side passes `max`; a smaller one is left alone. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const num = (value: number) => String(Math.round(value * 1000) / 1000);
const CROP_RADIUS: Record<Exclude<BotAvatarCrop, "mascot">, number> = { circle: FACE_PX / 2, rounded: FACE_PX * 0.22, square: 0 };

/** A photo Chief as a face: the saved crop shape, then the same cover crop, focus point and zoom the app draws (shared/bot-avatar.ts
 * avatarFraming, src/components/Avatar.tsx), worked out here because an SVG image cannot take an arbitrary object-position. */
export function photoFaceSvg(options: { dataUri: string; width: number; height: number; crop: Exclude<BotAvatarCrop, "mascot">; zoom?: unknown; focusX?: unknown; focusY?: unknown; idPrefix?: string }): string {
  const { dataUri, width, height, crop } = options;
  if (!DATA_IMAGE.test(dataUri) || !(width > 0) || !(height > 0)) throw new Error("not an embeddable picture");
  const zoom = clampAvatarZoom(options.zoom ?? AVATAR_ZOOM_MIN);
  const fx = clampAvatarFocus(options.focusX ?? AVATAR_FOCUS_CENTER);
  const fy = clampAvatarFocus(options.focusY ?? AVATAR_FOCUS_CENTER);
  const cover = Math.max(FACE_PX / width, FACE_PX / height);
  const w = width * cover;
  const h = height * cover;
  const x = (FACE_PX - w) * fx;
  const y = (FACE_PX - h) * fy;
  const ox = fx * FACE_PX;
  const oy = fy * FACE_PX;
  const id = `${options.idPrefix ?? "fp"}-clip`;
  const radius = CROP_RADIUS[crop] ?? 0;
  const shape = crop === "circle"
    ? `<circle cx="${FACE_PX / 2}" cy="${FACE_PX / 2}" r="${FACE_PX / 2}"/>`
    : `<rect width="${FACE_PX}" height="${FACE_PX}"${radius ? ` rx="${num(radius)}"` : ""}/>`;
  const zoomed = zoom === AVATAR_ZOOM_MIN ? "" : ` transform="translate(${num(ox)} ${num(oy)}) scale(${num(zoom)}) translate(${num(-ox)} ${num(-oy)})"`;
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${FACE_PX} ${FACE_PX}" width="${FACE_PX}" height="${FACE_PX}"><defs><clipPath id="${id}">${shape}</clipPath></defs>` +
    `<g clip-path="url(#${id})"><g${zoomed}><image href="${dataUri}" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" preserveAspectRatio="none"/></g></g></svg>`;
}

export interface PhotoDeps {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  /** Shrink the picture to `max` pixels at most and return it as a data URI with its size; null when it cannot be read. */
  scale: (blob: Blob, max: number) => Promise<LoadedPhoto | null>;
}

/** A bot's uploaded photo, fetched from this app's own attachment store and shrunk to 96 px. Anything else (another address, a
 * missing file, a picture that will not decode, being offline) is null, and the caller draws the mascot instead. */
/** A paint reference to an id inside the same picture, written out of parts: it names the picture's own gradients, never an address to load. */
const PAINT_FN = ["ur", "l("].join("");
const LOCAL_PAINT_REF = new RegExp(["ur", "l\\(\\s*([\"']?)#([^)\"']*)\\1\\s*\\)"].join(""), "g");

export async function downscalePhoto(url: string, deps: PhotoDeps): Promise<LoadedPhoto | null> {
  if (!botAvatarProfile({ avatarUrl: url, avatarCrop: "circle" }).avatarUrl) return null;
  try {
    const response = await deps.fetchImpl(url, { headers: desktopCallerHeaders(), redirect: "error" });
    if (!response.ok) return null;
    return await deps.scale(await response.blob(), PHOTO_PX);
  } catch { return null; }
}

export interface ComposeInput {
  roster: { chief: FaceBot | null; mates: readonly FaceBot[] };
  /** The app language code ("en", "de", "pt-br"). */
  language: string;
  os: TipOs;
  phoneAvailable: boolean;
  /** The tip index this start showed (what main read from the saved picture), or null when there was no picture. */
  sessionTip: number | null;
  loadStrings: (language: string) => Promise<TipStrings>;
  /** The real Ember mascot for this bot in this state, as standalone SVG (ids already prefixed); null when it cannot be drawn. */
  renderMascot: (bot: FaceBot, state: FaceState) => Promise<string | null>;
  loadPhoto: (url: string) => Promise<LoadedPhoto | null>;
  now: () => number;
}

async function face(input: ComposeInput, chief: FaceBot, state: FaceState): Promise<string | null> {
  const profile = botAvatarProfile(chief);
  if (profile.avatarUrl && profile.avatarCrop !== "mascot") {
    const photo = await input.loadPhoto(profile.avatarUrl).catch(() => null);
    if (photo) {
      try {
        return photoFaceSvg({ dataUri: photo.dataUri, width: photo.width, height: photo.height, crop: profile.avatarCrop, zoom: chief.avatarZoom, focusX: chief.avatarFocusX, focusY: chief.avatarFocusY, idPrefix: state === "idle" ? "fa" : "fb" });
      } catch { /* an unusable photo falls through to the mascot */ }
    }
  }
  return input.renderMascot(chief, state).catch(() => null);
}

/** The picture the NEXT start shows: the tip after the one this start showed (skipping a tip this computer cannot use), in the
 * Chief's words, with the Chief's two faces. null when there is no Chief or a face cannot be drawn: the splash then keeps its
 * bundled default, and nothing half-made is ever saved. */
export async function composeStartupPicture(input: ComposeInput): Promise<StartupPicturePayload | null> {
  const chief = input.roster.chief;
  if (!chief) return null;
  const base = input.sessionTip === null ? 0 : input.sessionTip;
  const index = pickTipIndex(nextTipIndex(base), input);
  const mates = faceRow(input.roster.mates).shown;
  const [strings, faceA, faceB, mateFaces] = await Promise.all([
    input.loadStrings(input.language),
    face(input, chief, "idle"),
    face(input, chief, "happy"),
    Promise.all(mates.map((mate) => face(input, mate, "idle"))),
  ]);
  if (!faceA || !faceB) return null;
  const tip = tipText(STARTUP_TIP_IDS[index], { chief: chief.name, mates: input.roster.mates.map((bot) => bot.name), os: input.os, phoneAvailable: input.phoneAvailable }, strings);
  const payload: StartupPicturePayload = { v: PICTURE_VERSION, tipNext: index, faceA, faceB, tip, at: input.now() };
  // a face that could not be drawn is left out and counted in the "+N"
  const faces = mateFaces.filter((entry): entry is string => typeof entry === "string");
  // the whole file stays far inside the main-process limit: photo faces are the big ones, so the row gives way first
  while (faces.length > 0 && JSON.stringify({ ...payload, team: { faces, more: 0 } }).length > TEAM_BUDGET_CHARS) faces.pop();
  if (faces.length > 0) payload.team = { faces, more: input.roster.mates.length - faces.length };
  return payload;
}

/** The real photo scaler (a browser): decode, draw into a canvas at most 96 px, and read it back as PNG (or JPEG for a photograph). */
export async function scaleInBrowser(blob: Blob, max: number): Promise<LoadedPhoto | null> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, max);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const keepsAlpha = /image\/(?:png|webp|gif)/.test(blob.type);
    const dataUri = canvas.toDataURL(keepsAlpha ? "image/png" : "image/jpeg", 0.85);
    return DATA_IMAGE.test(dataUri) ? { dataUri, width, height } : null;
  } finally {
    bitmap.close();
  }
}
