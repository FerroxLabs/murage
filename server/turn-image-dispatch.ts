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
/** What the turn ended up doing once the attachments were actually looked
 * at. `ImageDelivery` is the plan from engine and model alone; this adds the
 * one outcome the plan cannot know in advance — an inline engine whose turn
 * carried a tag the conversation never bound, so some or all of its pictures
 * went out as paths after all. */
export type ImageDeliveryOutcome = ImageDelivery | "mixed";

/** How an inline engine treats an `<attached-image path>` that Murage wrote
 * but this conversation never bound (a legacy upload made without a thread,
 * or a tag carried in from another thread). Nothing inlines it either way;
 * the question is whether the turn goes on without it.
 *
 * Fuigo has refused the turn outright since inline images arrived — a
 * deliberate "reattach it" rather than a bot quietly not seeing a picture
 * the person plainly attached. Every other engine that now inlines
 * (Claude, Codex, the rest of the ACP family) never hit that read at all
 * before 0.1.55: the tag went through as text and the engine opened the file
 * itself. Widening the inline gate silently gave those engines Fuigo's
 * refusal, which lost whole turns that had worked. Each keeps what it
 * shipped with; unifying them is a product decision, not a side effect. */
export type UnboundImagePolicy = "refuse" | "path";
export function unboundImagePolicy(driverKind: string): UnboundImagePolicy {
  return driverKind === "fuigoAgent" ? "refuse" : "path";
}

/** Fold what `collect` found back into the plan, so the sentence the bot
 * reads describes the turn it is actually in. Only an `inline` plan can be
 * revised: a path engine was never going to inline, and an unsighted bot is
 * unsighted whatever the tags say. */
export function imageDeliveryOutcome(
  plan: ImageDelivery,
  collected: { images: ReadonlyArray<unknown>; unbound: ReadonlyArray<string> } | undefined,
): ImageDeliveryOutcome {
  if (plan !== "inline" || !collected?.unbound.length) return plan;
  return collected.images.length ? "mixed" : "path";
}

export const IMAGE_DELIVERY_PROMPT: Readonly<Record<ImageDeliveryOutcome, string>> = {
  inline:
    " Images attached to this turn are already in front of you: look at them directly and do not open image files with shell or file-read tools to see them.",
  path:
    " You are not shown attached images directly — an attachment reaches you only as the <attached-image path=…> reference in the message, so open that path with your file-read tool if you need to look at it.",
  unsighted:
    " You will not be able to see an image attached here: say so and ask for a description instead of opening the file or guessing at it. Reading the image file would only fill your context with bytes you cannot interpret.",
  mixed:
    " Some images attached to this turn are already in front of you. Any <attached-image path=…> reference in the message whose picture you cannot see reached you only as that path: open it with your file-read tool if you need to look at it.",
};
