/** Who gets the picture itself, and who gets a path to it.
 *
 * Kept out of index.ts so the rule can be tested without standing up a
 * server: it is the one place that decides whether an attached image is put
 * in front of a model or left as an `<attached-image path=…>` reference the
 * bot must open with a read tool. */

/** @param imagesInline the DRIVER's `capabilities.imagesInline` — true only
 *  when that driver actually consumes `SendTurnInput.images`. Deliberately
 *  not the looser `capabilities.images`, which answers the composer's
 *  question ("may this engine be offered an attachment at all") and is true
 *  for pi and Antigravity, whose protocols take no image.
 *  @param modelAcceptsImages the MODEL's vision fact: `true` it can see,
 *  `false` it cannot, `undefined` Murage does not know (an engine-managed
 *  model has no BYOK catalog to ask). Only an explicit `false` refuses —
 *  treating "don't know" as "no" would take the picture away from every
 *  non-BYOK turn, which is nearly all of them. */
export function sendsInlineImages(
  imagesInline: boolean | undefined,
  modelAcceptsImages: boolean | undefined,
): boolean {
  if (imagesInline !== true) return false;
  return modelAcceptsImages !== false;
}
