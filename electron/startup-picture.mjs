// SPDX-License-Identifier: AGPL-3.0-or-later
// The cached startup picture (FIRSTRUN-1019 section 2.2 and 2.4, contract K2).
//
// The splash runs before the server, in a page with `default-src 'none'`, so the person's own Chief
// face and the next tip can only be there if they were saved ahead of time. The renderer composes the
// two faces and the tip text and hands them to main (`startup-picture:save`); main validates and
// writes `userData/startup-picture.json`; the next start reads it here and the splash embeds each face
// as an <img>-style data URI, never as markup.
//
// Everything here is cosmetic. The reader returns null on anything odd and never throws, so a missing,
// oversized, symlinked, stale or hostile file shows the bundled default lockup instead of a blank window.
// Pure Node, no Electron import.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const PICTURE_FILE = "startup-picture.json";
export const PICTURE_VERSION = 1;
/** The whole file, in bytes. Two small SVG faces and one tip fit far inside this. */
export const PICTURE_MAX_BYTES = 192 * 1024;
const FACE_MAX_CHARS = 90 * 1024;
const TIP_COUNT = 12;
const FIELD_LIMITS = Object.freeze({ id: 24, head: 120, line: 240, try: 160 });

const isString = (value) => typeof value === "string";

/** True when an SVG face is a standalone picture that cannot run script or reach out: no script, no event
 * attributes, no foreignObject, no doctype or entities, and every href or url() is a data image or a same-document id. */
export function isInertSvg(svg) {
  if (!isString(svg) || svg.length < 20 || svg.length > FACE_MAX_CHARS) return false;
  if (!/^\s*<svg[\s>]/i.test(svg) || !/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(svg)) return false;
  if (/<\s*(script|foreignObject|iframe|object|embed|animate|set|use\b[^>]*\bhref\s*=\s*["'](?!#))/i.test(svg)) return false;
  if (/<\s*[A-Za-z_][\w.-]*:[\w.-]+/.test(svg) || /\sxmlns:(?!xlink\b)/i.test(svg)) return false; // no prefixed element names (<s:script>) and no extra namespace prefixes
  if (/<!\s*(doctype|entity)/i.test(svg) || /<\?/.test(svg)) return false;
  if (/\son[a-z]+\s*=/i.test(svg)) return false;
  for (const match of svg.matchAll(/\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gis)) {
    const value = match[2].trim();
    if (!(value.startsWith("#") || /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(value))) return false;
  }
  for (const match of svg.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)) {
    if (!match[2].trim().startsWith("#")) return false;
  }
  if (/javascript:/i.test(svg) || /@import/i.test(svg)) return false;
  return true;
}

/** The optional roster row: at most five inert faces and a count. Anything else and the row is simply not there. */
function validTeam(team) {
  if (!team || typeof team !== "object" || Array.isArray(team)) return null;
  if (!Array.isArray(team.faces) || team.faces.length === 0 || team.faces.length > 5) return null;
  if (!team.faces.every((face) => isInertSvg(face))) return null;
  if (!Number.isInteger(team.more) || team.more < 0 || team.more > 9999) return null;
  return { faces: team.faces.slice(), more: team.more };
}

/** The picture in its stored shape, or null. Strings are length-checked; the tip id is a plain lowercase word. */
export function validatePicture(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.v !== PICTURE_VERSION) return null;
  if (!Number.isInteger(value.tipNext) || value.tipNext < 0 || value.tipNext >= TIP_COUNT) return null;
  if (!isInertSvg(value.faceA) || !isInertSvg(value.faceB)) return null;
  const tip = value.tip;
  if (!tip || typeof tip !== "object" || Array.isArray(tip)) return null;
  for (const key of Object.keys(FIELD_LIMITS)) {
    if (!isString(tip[key]) || tip[key].length === 0 || tip[key].length > FIELD_LIMITS[key]) return null;
  }
  if (!/^[a-z]{2,24}$/.test(tip.id)) return null;
  if (!Number.isFinite(value.at)) return null;
  const team = validTeam(value.team);
  return {
    v: PICTURE_VERSION,
    tipNext: value.tipNext,
    faceA: value.faceA,
    faceB: value.faceB,
    ...(team ? { team } : {}),
    tip: { id: tip.id, head: tip.head, line: tip.line, try: tip.try },
    at: value.at,
  };
}

function resolveUserData(userData) {
  if (typeof userData === "function") userData = userData();
  return typeof userData === "string" && path.isAbsolute(userData) ? userData : null;
}

/** Read the saved picture. lstat first: a regular file only (never a symlink), at most PICTURE_MAX_BYTES. null on anything else. */
export function readStartupPicture({ userData, fsImpl = fs } = {}) {
  try {
    const dir = resolveUserData(userData);
    if (!dir) return null;
    const file = path.join(dir, PICTURE_FILE);
    const info = fsImpl.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > PICTURE_MAX_BYTES) return null;
    const text = fsImpl.readFileSync(file, "utf8");
    if (text.length > PICTURE_MAX_BYTES) return null;
    return validatePicture(JSON.parse(text));
  } catch { return null; }
}

/** Validate and save a picture: temp file in the same folder, mode 0600, then rename. Returns true when written. */
export function writeStartupPicture({ userData, picture, fsImpl = fs } = {}) {
  let temp = null;
  try {
    const dir = resolveUserData(userData);
    const clean = validatePicture(picture);
    if (!dir || !clean) return false;
    const text = JSON.stringify(clean);
    if (Buffer.byteLength(text) > PICTURE_MAX_BYTES) return false;
    const file = path.join(dir, PICTURE_FILE);
    try { if (fsImpl.lstatSync(file).isSymbolicLink()) fsImpl.unlinkSync(file); } catch { /* none yet */ }
    // a name nobody can guess, created exclusively: a planted symlink at the name is refused, never written through
    temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    fsImpl.writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    fsImpl.renameSync(temp, file);
    return true;
  } catch {
    try { if (temp) fsImpl.unlinkSync(temp); } catch { /* cosmetic */ }
    return false;
  }
}
