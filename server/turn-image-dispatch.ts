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

/** What this turn will actually do with an attached picture.
 *  - `inline`: the bytes ride the prompt; the bot can look straight at them.
 *  - `path`: the bot is sighted but the engine carries no image, so the
 *    `<attached-image path=…>` tag in the text is all it gets — it opens the
 *    file itself. pi and Antigravity, on a model that can see.
 *  - `unsighted`: the bot cannot end up seeing the picture at all, whether
 *    because the engine takes no image (ACP grok) or because the routed
 *    model has no vision. It must NOT be told to open the file: reading a
 *    PNG into a text-only model's context is the 400 of 2026-09-17. */
export type ImageDelivery = "inline" | "path" | "unsighted";

/** One rule, so the turn's sentence and the dispatch decision cannot drift.
 *
 * The ordering matters. `sendsInlineImages` already folds the engine and the
 * model together, but it answers "did we send the bytes", and "no" has two
 * causes that call for opposite instructions: an engine that cannot carry a
 * picture to a bot that could have seen one, versus a bot that could not have
 * seen one either way. Splitting them is the whole point of this function.
 *
 * `undefined` vision stays permissive here exactly as it is in
 * `sendsInlineImages`: it means Murage holds no catalog fact, which is every
 * engine-managed model, and reading it as "no" would put "ask for a
 * description" on nearly every turn in the product. */
export function imageDelivery(
  capabilities: { images?: boolean; imagesInline?: boolean },
  modelAcceptsImages: boolean | undefined,
): ImageDelivery {
  // "Can this bot see a picture at all" is asked FIRST, and it is asked of
  // both facts. A driver declaring `imagesInline` without `images` is a
  // driver bug rather than a live shape, but the safe reading of it is "do
  // not send" — and asking this first is also what keeps this answer
  // identical to the primer's, which derives `unsupported` from `images`
  // alone before it looks at anything else.
  if (capabilities.images !== true || modelAcceptsImages === false) return "unsighted";
  return sendsInlineImages(capabilities.imagesInline, modelAcceptsImages) ? "inline" : "path";
}

/** The sentence the turn puts in the system prompt. It sits a few hundred
 * characters from the capabilities primer's own image line, so the two have
 * to answer "can you see the picture" the same way —
 * server/turn-image-prompt-agreement.test.ts holds them to it. */
export const IMAGE_DELIVERY_PROMPT: Readonly<Record<ImageDelivery, string>> = {
  inline:
    " Images attached to this turn are already in front of you: look at them directly and do not open image files with shell or file-read tools to see them.",
  path:
    " You are not shown attached images directly — an attachment reaches you only as the <attached-image path=…> reference in the message, so open that path with your file-read tool if you need to look at it.",
  unsighted:
    " You will not be able to see an image attached here: say so and ask for a description instead of opening the file or guessing at it. Reading the image file would only fill your context with bytes you cannot interpret.",
};
