// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which text may be answered from outside the app, per surface (NOTIFY-EVERYWHERE-1019 section 5.1, S0 and the S4a fit amendment).
// A card is answerable on a surface only when its WHOLE detail shows there with no truncation. Fit is a rendering envelope, not a
// character count, and the accepted repertoire is explicit and closed: an OS banner or the tray menu accepts printable ASCII and
// line breaks only until S0 proves more; our own scrolling windows (pill, flyout, bubble, dock) show everything and accept
// printable text that is not invisible, not a control, not a separator other than a plain space and not unassigned.
// Shared by the server and main.

export const OUTSIDE_SURFACES = Object.freeze(["banner-mac", "banner-win", "banner-linux", "menu", "pill", "flyout", "bubble", "dock"]);

export const REPERTOIRES = Object.freeze(["ascii", "extended"]);

const OPEN_ONLY = Object.freeze({ maxLines: 0, maxLineChars: 0, titleChars: 0, nameChars: 0, repertoire: "ascii" });
const SCROLLING = Object.freeze({ maxLines: 60, maxLineChars: 120, titleChars: 120, nameChars: 60, repertoire: "extended" });

/** S0 fills the OS entries (a hard prerequisite for S4a, S4b, S4c and S6). Until then every OS banner and the menu are Open only. */
export const OUTSIDE_ENVELOPES = Object.freeze({
  "banner-mac": OPEN_ONLY, "banner-win": OPEN_ONLY, "banner-linux": OPEN_ONLY, menu: OPEN_ONLY,
  pill: SCROLLING, flyout: SCROLLING, bubble: SCROLLING, dock: SCROLLING,
});

/** The surfaces whose rendering we do not control: their envelope must say "ascii" explicitly. */
const OS_SURFACES = Object.freeze(["banner-mac", "banner-win", "banner-linux", "menu"]);

// Anything that is invisible, a control, a separator (except U+0020), a surrogate, private-use or unassigned is never accepted in
// the extended repertoire: it can hide executable detail or break line counting. Unicode properties, not a hand-kept list, so a
// newly assigned character (tags U+E0020 and friends) is covered. U+2028 and U+2029 are separators (Zl, Zp), also refused.
const REFUSED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}]/u;
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|\p{Extended_Pictographic}/u;

const widthOf = char => (WIDE.test(char) ? 2 : 1);
const measure = text => { let total = 0; for (const char of text) total += widthOf(char); return total; };

/** Accepted text: no tabs, no control characters (a line break is fine), nothing invisible; "ascii" is printable ASCII only.
 *  An unknown repertoire accepts nothing (it never falls open). */
export function repertoireOk(text, repertoire) {
  if (typeof text !== "string" || !REPERTOIRES.includes(repertoire)) return false;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (char === "\n") continue;
    if (char === " ") continue;
    if (repertoire === "ascii") { if (code < 0x21 || code > 0x7E) return false; continue; }
    if (REFUSED.test(char)) return false;
  }
  return true;
}

/** How many lines `text` takes: split on explicit breaks, then greedy word wrap per line the way banners do (break at spaces; a
 *  word that does not fit moves whole to the next line; a token longer than `width` is split). Wide characters count two. */
export function wrappedLineCount(text, width) {
  let lines = 0;
  for (const line of text.split("\n")) {
    let used = 0, count = 1;
    for (const word of line.split(" ")) {
      const size = measure(word);
      if (size > width) {
        // a long token starts on a fresh line when something is already there, then fills lines of `width`
        if (used > 0) { count += 1; used = 0; }
        let fill = 0;
        for (const char of word) { const w = widthOf(char); if (fill + w > width) { count += 1; fill = 0; } fill += w; }
        used = fill; continue;
      }
      if (used === 0) used = size;
      else if (used + 1 + size <= width) used += 1 + size;
      else { count += 1; used = size; }
    }
    lines += count;
  }
  return lines;
}

/** Whether `surface`'s envelope is well formed: a known repertoire, and an explicit "ascii" on every OS surface. */
export function envelopeValid(surface, envelope) {
  if (!envelope || !REPERTOIRES.includes(envelope.repertoire)) return false;
  if (!OS_SURFACES.includes(surface)) return true;
  if (envelope.repertoire !== "ascii") return false;
  // An OS envelope that turns actions on (maxLines above 0) must also carry the whole-template bound S0 measured.
  return !(envelope.maxLines > 0 && !Number.isFinite(envelope.templateLines));
}

/** Whether the full detail, the title and the bot name all show inside `envelope` without truncation. Every field is one rendered
 *  unit of the template: the bot name on one line, the title on one line, the detail wrapped; together they must stay inside
 *  `maxLines` when the envelope sets `templateLines`, the whole-template bound S0 measures. */
export function fitsEnvelope(willRun, title, botName, envelope) {
  if (!envelope || !(envelope.maxLines > 0) || !(envelope.maxLineChars > 0)) return false;
  if (!REPERTOIRES.includes(envelope.repertoire)) return false;
  for (const value of [willRun, title, botName]) if (typeof value !== "string" || value.trim() === "" || !repertoireOk(value, envelope.repertoire)) return false;
  if (title.includes("\n") || botName.includes("\n")) return false;
  if (measure(title) > envelope.titleChars || measure(botName) > envelope.nameChars) return false;
  const detail = wrappedLineCount(willRun, envelope.maxLineChars);
  if (detail > envelope.maxLines) return false;
  return typeof envelope.templateLines !== "number" || detail + 2 <= envelope.templateLines;
}
