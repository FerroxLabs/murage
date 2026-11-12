// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE MURAGE LOGO, AS DATA. One builder, used by the first-install welcome, the start screens and the tip header,
// so every picture of the logo is the same picture.
//
// The mark is the lucide galaxy (ISC) in brand orange. The wordmark is MURAGE in Sora 800 (OFL 1.1) turned into
// outlines once, so it draws the same in the renderer and in the splash (a data: page with no font access) and the
// app ships no font file for it. Proportions come from brand/logo-dark.svg: mark height 1.43 times cap height, gap
// 0.35 times cap height.
//
// Pure: the same options give the same string. No text nodes, no script, no external reference.

export const BRAND_ORANGE = "#ff6b35";

/** The galaxy: two arms and the two stray dots, in the 24 by 24 box lucide draws them in. Byte-identical to the
 *  paths in electron/startup-splash.mjs and brand/mark.svg. */
export const GALAXY_PATHS = [
  "M16.005 15.108a5.041 6.52 28.25 00-8.008-6.217 5.041 6.52 28.25 008.008 6.217A11.884 7.288-60.76 014.029 7.001",
  "M17 21h.01",
  "M7 3h.01",
  "M7.997 8.891a11.885 7.288-60.756 0111.977 8.107",
];
/** The galaxy's centre dot (cx, cy, r in the same 24 box). */
export const GALAXY_CORE = { cx: 12, cy: 12, r: 1 };
export const GALAXY_STROKE = 1.9;

/** MURAGE, Sora 800, size 84, letter-spacing -2, baseline 96, starting at x 115.7, kerned. Outlined. */
export const WORDMARK_PATH =
  "M121.92 96V34.68H143.59L156.19 67.02H157.87L170.38 34.68H192.48V96H177.02V43.67L179.46 43.84L163.66 83.65H149.47L133.59 43.84L136.2 43.67V96ZM229.12 97.68Q220.3 97.68 214.21 94.4Q208.12 91.13 204.92 85.12Q201.73 79.12 201.73 70.88V34.68H217.36V71.22Q217.36 74.83 218.74 77.52Q220.13 80.21 222.73 81.64Q225.34 83.06 229.12 83.06Q232.9 83.06 235.5 81.64Q238.1 80.21 239.45 77.56Q240.79 74.92 240.79 71.22V34.68H256.42V70.88Q256.42 79.12 253.27 85.12Q250.12 91.13 244.03 94.4Q237.94 97.68 229.12 97.68ZM265.67 96V34.18H281.3V96ZM302.63 96 285.41 69.96H302.38L320.61 96ZM277.35 77.18V65.17H292.05Q294.82 65.17 296.84 64.08Q298.85 62.99 299.99 60.97Q301.12 58.96 301.12 56.27Q301.12 53.5 299.99 51.48Q298.85 49.46 296.84 48.37Q294.82 47.28 292.05 47.28H277.35V34.18H291.12Q299.1 34.18 304.9 36.57Q310.7 38.96 313.8 43.63Q316.91 48.29 316.91 55.18V56.52Q316.91 63.41 313.76 67.99Q310.61 72.56 304.86 74.87Q299.1 77.18 291.12 77.18ZM320.29 96 339.94 34.68H364.98L385.3 96H369.18L353.38 45.6L357.84 47.28H346.75L351.28 45.6L335.91 96ZM336.33 81.8 341.04 69.04H364.3L369.01 81.8ZM417.07 97.68Q408.42 97.68 402.2 94.78Q395.99 91.88 392.04 87.18Q388.09 82.48 386.24 76.93Q384.4 71.39 384.4 66.1V64.25Q384.4 58.54 386.33 52.95Q388.26 47.36 392.17 42.83Q396.07 38.29 401.95 35.56Q407.83 32.83 415.73 32.83Q424.21 32.83 430.72 35.94Q437.23 39.05 441.18 44.55Q445.13 50.05 445.8 57.28H430.18Q429.67 54.5 427.74 52.28Q425.81 50.05 422.74 48.75Q419.68 47.45 415.73 47.45Q411.95 47.45 409.05 48.75Q406.15 50.05 404.18 52.45Q402.2 54.84 401.2 58.12Q400.19 61.39 400.19 65.26Q400.19 69.12 401.28 72.44Q402.37 75.76 404.47 78.23Q406.57 80.71 409.76 82.06Q412.96 83.4 417.07 83.4Q422.28 83.4 426.06 81.22Q429.84 79.03 431.35 75.42L430.18 84.66V71.3H444.46V83.9Q440.59 90.54 433.49 94.11Q426.4 97.68 417.07 97.68ZM415.39 74.33V63.41H449.5V74.33ZM455.39 96V34.68H470.51V96ZM468.83 96V83.23H494.7V96ZM468.83 71.22V58.45H492.94V71.22ZM468.83 47.45V34.68H494.2V47.45Z";

/** Where the mark sits in the lockup's user space. */
export const MARK_BOX = { x: 8, y: 22.52, size: 86.49 };
/** The galaxy's 24 box scaled up to MARK_BOX.size (the brand file's own scale). */
export const MARK_SCALE = 3.6036;
/** The picture's user-space frame: wide enough for the wordmark and for Ember's overhang at the lower left. */
export const LOCKUP_FRAME = { x: -4, y: 0, width: 512, height: 128 };

/** Ember against the mark: 0.6 of its size, its left edge 0.11 of the mark left of the mark, its foot 0.1 below it.
 *  That corner is the galaxy's empty quarter. */
export const EMBER_PLACE = { scale: 0.6, left: -0.11, bottom: -0.1 };

/** One serialised render of the real EmberAvatar (orange, default body, resting face), used when no saved face
 *  exists. src/assets/brand/ember-default.svg holds the same text; the test regenerates it from the component. */
export const EMBER_DEFAULT_SVG = "<svg viewBox=\"-15 -15 258.541 258.541\" width=\"64px\" height=\"64px\" aria-hidden=\"true\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"ember-default-0\" x1=\"1\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#ffbca4\"></stop><stop offset=\"55%\" stop-color=\"#FF6B35\"></stop><stop offset=\"100%\" stop-color=\"#943e1f\"></stop></linearGradient><clipPath id=\"ember-default-1\" transform=\"translate(29.8314 0.0041) scale(0.896884)\"><path xmlns=\"http://www.w3.org/2000/svg\" d=\"M187.899,164.809 C185.803,214.868 144.574,254.812 94.000,254.812 C42.085,254.812 -0.000,211.312 -0.000,160.812 C-0.000,154.062 -0.121,140.572 10.000,117.812 C16.057,104.191 19.856,95.634 22.000,87.812 C23.178,83.513 25.469,76.683 32.000,87.812 C35.851,94.374 36.000,103.812 36.000,103.812 C36.000,103.812 50.328,92.817 60.000,71.812 C74.179,41.019 62.866,22.612 59.000,9.812 C57.662,5.384 56.822,-2.574 66.000,0.812 C75.352,4.263 100.076,21.570 113.000,39.812 C131.445,65.847 138.000,90.812 138.000,90.812 C138.000,90.812 143.906,83.482 146.000,75.812 C148.365,67.151 148.400,58.573 155.999,67.813 C163.226,76.600 173.959,93.113 180.000,108.812 C190.969,137.321 187.899,164.809 187.899,164.809 Z\" fill-rule=\"evenodd\"></path><path xmlns=\"http://www.w3.org/2000/svg\" d=\"M94.000,254.812 C58.101,254.812 29.000,225.711 29.000,189.812 C29.000,168.151 37.729,155.000 55.896,137.166 C67.528,125.747 78.415,111.722 83.042,102.172 C83.953,100.292 86.026,90.495 94.019,101.966 C98.212,107.982 104.785,118.681 109.000,127.812 C116.266,143.555 118.000,158.812 118.000,158.812 C118.000,158.812 125.121,154.616 130.000,143.812 C131.573,140.330 134.753,127.148 143.643,140.328 C150.166,150.000 159.127,167.390 159.000,189.812 C159.000,225.711 129.898,254.812 94.000,254.812 Z\" fill-rule=\"evenodd\"></path><path xmlns=\"http://www.w3.org/2000/svg\" d=\"M95.000,183.812 C104.250,183.812 104.250,200.941 116.000,223.812 C123.824,239.041 112.121,254.812 95.000,254.812 C77.879,254.812 69.000,240.933 69.000,223.812 C69.000,206.692 85.750,183.812 95.000,183.812 Z\" fill-rule=\"evenodd\"></path></clipPath></defs><g><g></g><g></g><g><g style=\"opacity: 1;\"><g transform=\"translate(29.8314 0.0041) scale(0.896884)\">\n  \n  <defs xmlns=\"http://www.w3.org/2000/svg\">\n    \n\n    <linearGradient id=\"ember-default-2\" gradientUnits=\"userSpaceOnUse\" x1=\"94.141\" y1=\"255\" x2=\"94.141\" y2=\"0.188\">\n      <stop offset=\"0\" stop-color=\"#ff4c0d\"></stop>\n      <stop offset=\"1\" stop-color=\"#fc9502\"></stop>\n    </linearGradient>\n  </defs>\n  <g xmlns=\"http://www.w3.org/2000/svg\" id=\"ember-default-3\" fill=\"url(#ember-default-0)\">\n    <path d=\"M187.899,164.809 C185.803,214.868 144.574,254.812 94.000,254.812 C42.085,254.812 -0.000,211.312 -0.000,160.812 C-0.000,154.062 -0.121,140.572 10.000,117.812 C16.057,104.191 19.856,95.634 22.000,87.812 C23.178,83.513 25.469,76.683 32.000,87.812 C35.851,94.374 36.000,103.812 36.000,103.812 C36.000,103.812 50.328,92.817 60.000,71.812 C74.179,41.019 62.866,22.612 59.000,9.812 C57.662,5.384 56.822,-2.574 66.000,0.812 C75.352,4.263 100.076,21.570 113.000,39.812 C131.445,65.847 138.000,90.812 138.000,90.812 C138.000,90.812 143.906,83.482 146.000,75.812 C148.365,67.151 148.400,58.573 155.999,67.813 C163.226,76.600 173.959,93.113 180.000,108.812 C190.969,137.321 187.899,164.809 187.899,164.809 Z\" id=\"ember-default-4\" class=\"cls-3\" fill-rule=\"evenodd\"></path>\n    <path d=\"M94.000,254.812 C58.101,254.812 29.000,225.711 29.000,189.812 C29.000,168.151 37.729,155.000 55.896,137.166 C67.528,125.747 78.415,111.722 83.042,102.172 C83.953,100.292 86.026,90.495 94.019,101.966 C98.212,107.982 104.785,118.681 109.000,127.812 C116.266,143.555 118.000,158.812 118.000,158.812 C118.000,158.812 125.121,154.616 130.000,143.812 C131.573,140.330 134.753,127.148 143.643,140.328 C150.166,150.000 159.127,167.390 159.000,189.812 C159.000,225.711 129.898,254.812 94.000,254.812 Z\" id=\"ember-default-5\" class=\"cls-4\" fill-rule=\"evenodd\"></path>\n    <path d=\"M95.000,183.812 C104.250,183.812 104.250,200.941 116.000,223.812 C123.824,239.041 112.121,254.812 95.000,254.812 C77.879,254.812 69.000,240.933 69.000,223.812 C69.000,206.692 85.750,183.812 95.000,183.812 Z\" id=\"ember-default-6\" class=\"cls-5\" fill-rule=\"evenodd\"></path>\n  </g>\n</g><g clip-path=\"url(#ember-default-1)\" style=\"opacity: 1;\"><g transform=\"translate(103.45 136.48) scale(1) translate(-120 -122.5)\"><path fill=\"#ffffff\" d=\"M94.52 99.06L96.67 99.13L98.76 99.58L100.73 100.43L102.50 101.64L104.00 103.18L105.18 104.97L106.02 106.94L106.46 109.04L106.52 111.18L106.26 113.31L105.84 115.42L105.39 117.52L105.00 119.63L104.61 121.74L104.22 123.85L103.80 125.96L103.35 128.06L102.69 130.10L101.69 132.00L100.35 133.67L98.72 135.07L96.86 136.14L94.84 136.86L92.73 137.21L90.58 137.16L88.48 136.71L86.52 135.86L84.76 134.64L83.27 133.09L82.09 131.30L81.26 129.32L80.83 127.22L80.80 125.08L81.08 122.95L81.50 120.85L81.95 118.75L82.37 116.64L82.78 114.53L83.18 112.42L83.57 110.31L83.98 108.20L84.59 106.15L85.56 104.23L86.89 102.55L88.51 101.15L90.38 100.09L92.40 99.39Z\" transform=\"translate(93.64 118.13) scale(1.0000 1.0000) translate(-93.64 -118.13)\" style=\"opacity: 1;\"></path><path fill=\"#ffffff\" d=\"M149.46 107.81L151.44 108.30L153.23 109.26L154.77 110.59L156.00 112.21L156.90 114.04L157.44 116.00L157.63 118.03L157.55 120.07L157.29 122.09L156.96 124.10L156.62 126.11L156.26 128.12L155.89 130.12L155.48 132.12L155.03 134.11L154.55 136.09L153.91 138.02L153.01 139.86L151.87 141.54L150.47 143.02L148.84 144.24L147.02 145.15L145.05 145.68L143.02 145.78L141.02 145.40L139.18 144.54L137.60 143.25L136.39 141.62L135.56 139.77L135.11 137.78L135.02 135.75L135.26 133.72L135.71 131.73L136.16 129.74L136.57 127.75L136.97 125.75L137.35 123.74L137.66 121.73L137.97 119.71L138.33 117.71L138.84 115.74L139.64 113.86L140.72 112.14L142.08 110.62L143.67 109.35L145.47 108.40L147.43 107.86Z\" transform=\"translate(146.36 126.87) scale(1.0000 1.0000) translate(-146.36 -126.87)\" style=\"opacity: 1;\"></path><path fill=\"none\" stroke=\"#ffffff\" stroke-width=\"7.5\" stroke-linecap=\"round\" d=\"M101.77 159.08 Q113.28 163.02 125.44 163.01\" transform=\"translate(113.60 161.05) scale(1.0000 1) translate(-113.60 -161.05)\" style=\"opacity: 1;\"></path></g></g></g><g style=\"opacity: 0;\"></g></g><g></g><g></g><g></g></g></svg>";

const num = (value) => String(Math.round(value * 100) / 100);

/** The only picture a face may be as a data URI: a raster image, base64, nothing else. */
const RASTER_DATA = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const FACE_FORBIDDEN_ELEMENT = /<\s*(?:script|style|iframe|object|embed|foreignObject|animate\w*|set|a|use|link|meta|image)\b/i;
const FACE_FORBIDDEN_NO_IMAGE = /<\s*(?:script|style|iframe|object|embed|foreignObject|animate\w*|set|a|use|link|meta)\b/i;
const FACE_ELEMENTS = new Set([
  "svg", "g", "defs", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "lineargradient", "radialgradient",
  "stop", "clippath", "mask", "pattern", "symbol",
]);
const FACE_OPENING_TAG = /^<svg((?:\s+[^\s=>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*>/i;
const POSITION_ATTRIBUTE = /\s+(?:x|y|width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi;

/** A face that is svg markup must be one self-contained svg element: no script, style, link or active element, no
 *  event attribute, no entity, and every reference either a fragment (#id) or an inline raster picture. */
function checkSvgFace(text, { rasterImages = false } = {}) {
  if (!/<\/svg>\s*$/i.test(text) || (text.match(/<svg[\s>]/gi) ?? []).length !== 1) throw new TypeError("lockupSvg: face must be one svg element");
  // A saved face that holds an uploaded photo draws it with one <image> whose href is an inline raster picture (the href rule below).
  if ((rasterImages ? FACE_FORBIDDEN_NO_IMAGE : FACE_FORBIDDEN_ELEMENT).test(text)) throw new TypeError("lockupSvg: face carries an element it may not carry");
  // Drawing elements only, by exact name: no prefixed name (s:script), no namespace declaration, no comment, CDATA or
  // processing instruction.
  if (/<[!?]|xmlns:/i.test(text)) throw new TypeError("lockupSvg: face carries markup it may not carry");
  for (const tag of text.matchAll(/<\s*\/?\s*([^\s>/]+)/g)) {
    if (!FACE_ELEMENTS.has(tag[1].toLowerCase()) && !(rasterImages && tag[1].toLowerCase() === "image")) throw new TypeError("lockupSvg: face carries an element it may not carry");
  }
  // An event attribute can follow a space, a slash or a quote; a backslash is a CSS or script escape; a style may
  // only be plain declarations (no url, no import, no expression).
  if (/[\s/"']on[a-z]+\s*=|&|xml:|\\|@import|javascript:|expression\(/i.test(text)) throw new TypeError("lockupSvg: face carries active content");
  for (const match of text.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    if (!/^[\sa-z0-9.:;,#%()-]*$/i.test(match[1] ?? match[2] ?? "") || /url|image|import|expression/i.test(match[1] ?? match[2] ?? "")) throw new TypeError("lockupSvg: face carries a style it may not carry");
  }
  if (/\bstyle\s*=\s*[^"'\s]/i.test(text)) throw new TypeError("lockupSvg: face has an unquoted style");
  if (/\bhref\s*=\s*[^"'\s]/i.test(text)) throw new TypeError("lockupSvg: face has an unquoted reference");
  for (const match of text.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (!value.startsWith("#") && !RASTER_DATA.test(value)) throw new TypeError("lockupSvg: face reaches outside itself");
  }
  for (const match of text.matchAll(/url\(\s*([^)]*)\)/gi)) {
    if (!/^["']?#[^"')\s]+["']?$/.test(match[1].trim())) throw new TypeError("lockupSvg: face reaches outside itself");
  }
}

/** Where Ember stands, in user-space units. */
export function emberBox() {
  const size = MARK_BOX.size * EMBER_PLACE.scale;
  const x = MARK_BOX.x + MARK_BOX.size * EMBER_PLACE.left;
  const bottom = MARK_BOX.y + MARK_BOX.size - MARK_BOX.size * EMBER_PLACE.bottom;
  return { x, y: bottom - size, size };
}

function faceMarkup(face, box) {
  if (typeof face !== "string" || face.length === 0) throw new TypeError("lockupSvg: face must be svg markup or a data URI");
  const place = `x="${num(box.x)}" y="${num(box.y)}" width="${num(box.size)}" height="${num(box.size)}"`;
  const text = face.trim();
  if (/^data:/i.test(text)) {
    // A saved face is a standalone svg held as a base64 data URI (the cached start-up picture). It stays an <image> source, never markup,
    // and is still held to the same svg rules as inline markup: decode, check, then embed the original URI.
    const svgUri = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/]+={0,2})$/.exec(text);
    if (svgUri) {
      const decoded = new TextDecoder().decode(Uint8Array.from(atob(svgUri[1]), (c) => c.charCodeAt(0))).trim();
      if (!FACE_OPENING_TAG.test(decoded)) throw new TypeError("lockupSvg: face must be svg markup or a data URI");
      checkSvgFace(decoded, { rasterImages: true });
      return `<image ${place} href="${text}"/>`;
    }
    if (!RASTER_DATA.test(text)) throw new TypeError("lockupSvg: face data URI must be a base64 png, jpeg, webp or gif");
    return `<image ${place} href="${text}"/>`;
  }
  const opening = FACE_OPENING_TAG.exec(text);
  if (!opening) throw new TypeError("lockupSvg: face must be svg markup or a data URI");
  checkSvgFace(text);
  // Re-place the face's own opening tag: drop its size and position, give it ours.
  const kept = opening[1].replace(POSITION_ATTRIBUTE, "");
  return `<svg${kept} ${place}>` + text.slice(opening[0].length);
}

/**
 * The lockup as one standalone SVG string.
 *   size   the mark's height in px (default 84); the picture scales from it.
 *   light  ink for a light ground (#111) instead of a dark one (white).
 *   face   Ember's face: svg markup or a data:image URI. Absent with ember "static" means the bundled default.
 *   ember  "none" (the plain logo, the first-load image) or "static" (Ember in place, finished).
 */
export function lockupSvg({ size = 84, light = false, face, ember = "none" } = {}) {
  if (ember !== "none" && ember !== "static") throw new TypeError(`lockupSvg: ember must be "none" or "static"`);
  const px = Number(size);
  if (!Number.isFinite(px) || px <= 0) throw new TypeError("lockupSvg: size must be a positive number");
  const k = px / MARK_BOX.size;
  const { x, y, width, height } = LOCKUP_FRAME;
  const ink = light ? "#111111" : "#ffffff";
  const ground = light ? "#f7f7f8" : "#111111";
  const mark = `<g transform="translate(${num(MARK_BOX.x)} ${num(MARK_BOX.y)}) scale(${MARK_SCALE})" fill="none" stroke="${BRAND_ORANGE}" stroke-width="${GALAXY_STROKE}" stroke-linecap="round" stroke-linejoin="round">`
    + GALAXY_PATHS.map((d) => `<path d="${d}"/>`).join("")
    + `<circle cx="${GALAXY_CORE.cx}" cy="${GALAXY_CORE.cy}" r="${GALAXY_CORE.r}" fill="${BRAND_ORANGE}" stroke="none"/></g>`;
  const word = `<path d="${WORDMARK_PATH}" fill="${ink}"/>`;
  let emberPart = "";
  let defs = "";
  if (ember === "static") {
    const markup = faceMarkup(face ?? EMBER_DEFAULT_SVG, emberBox());
    defs = `<defs><filter id="ml-halo" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="0" stdDeviation="1.4" flood-color="${ground}" flood-opacity="1"/></filter></defs>`;
    emberPart = `<g filter="url(#ml-halo)">${markup}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width * k)}" height="${num(height * k)}" viewBox="${x} ${y} ${width} ${height}" role="img" aria-label="Murage">`
    + defs + mark + word + emberPart + `</svg>`;
}
