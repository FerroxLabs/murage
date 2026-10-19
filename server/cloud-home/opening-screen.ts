// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The light "Opening your Murage home" screen a Cloud home paints before its app has loaded. The home's policy
// (b1b-policy.ts secureHomeHtml) allows scripts only from the home's own files, so index.html's inline palette script never
// runs there and the first frame used to be the dark default. This screen is markup plus a style block, no script: the
// first frame is already light and branded, and it stays until the app marks itself mounted (Door.tsx sets
// data-murage-mounted on <html>), so the app's first frames are painted underneath it.
//
// Colours are the app's light tokens (src/styles.css [data-skin="light"]): app ground, ink, inset and accent.

/** Same words as the door's own first state (src/lib/cloud-door.ts doorCopy.opening). */
export const OPENING_COPY = "Opening your Murage home";

export const OPENING_LIGHT = { app: "#f7f7f7", ink: "#0d0d0d", inset: "#eaeaea", accent: "#b8481f" } as const;

const { app, ink, inset, accent } = OPENING_LIGHT;
export const OPENING_STYLE = `<style id="murage-opening-style">`
  + `html:not([data-murage-mounted]){background:${app};color-scheme:light}`
  + `#murage-opening{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;`
  + `gap:20px;padding:24px;background:${app};color:${ink};text-align:center;`
  + `font:500 15px/1.5 "Inter",-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif}`
  + `#murage-opening img{width:180px;max-width:60vw;height:auto}`
  + `#murage-opening p{margin:0}`
  + `#murage-opening .murage-opening-bar{position:relative;width:120px;height:3px;border-radius:3px;background:${inset};overflow:hidden}`
  + `#murage-opening .murage-opening-bar::after{content:"";position:absolute;top:0;bottom:0;left:0;width:40%;border-radius:3px;background:${accent};`
  + `animation:murage-opening 1.2s ease-in-out infinite}`
  + `@keyframes murage-opening{from{transform:translateX(-100%)}to{transform:translateX(250%)}}`
  + `@media (prefers-reduced-motion:reduce){#murage-opening .murage-opening-bar::after{animation:none;width:100%;opacity:.5}}`
  + `html[data-murage-mounted] #murage-opening{display:none}`
  + `</style>`;

export const OPENING_MARKUP = `<div id="murage-opening" role="status" aria-live="polite">`
  + `<img src="/murage-logo-dark.png" alt="Murage" width="180" height="37">`
  + `<p>${OPENING_COPY}</p>`
  + `<div class="murage-opening-bar" aria-hidden="true"></div>`
  + `</div>`;

/** index.html with the opening screen: its style first in <head>, its markup first in <body>. Unchanged without both tags. */
export function withCloudOpening(html: string): string {
  if (!html.includes("<head>") || !html.includes("<body>")) return html;
  return html.replace("<head>", `<head>${OPENING_STYLE}`).replace("<body>", `<body>${OPENING_MARKUP}`);
}
