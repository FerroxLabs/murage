/** The turn's own image sentence and the capabilities primer go into the SAME
 * prompt, and they are derived from different code. On 2026-09-17 a bot on a
 * text-only model opened an attached PNG with read_file and the provider
 * 400'd on the image part. The sentence that told it to do that is the one
 * checked here, against the primer line sitting a few hundred characters
 * away in the same system prompt.
 *
 * The axis under test is deliberately NOT "inline versus path" — that is the
 * primer lane's to settle. It is the one thing a bot acts on: CAN I SEE THE
 * PICTURE AT ALL. A prompt that answers that twice, differently, is the bug. */
import { describe, expect, it } from "vitest";

import { turnCapabilityFacts, type ImageInput } from "./capabilities-primer.ts";
import { imageDelivery, IMAGE_DELIVERY_PROMPT, sendsInlineImages } from "./turn-image-dispatch.ts";

/** The two branches server/index.ts carried at 3127e0d9, copied verbatim so
 * the reproduction below measures the shipped sentence and not a paraphrase.
 * Kept after the fix as the thing the mutation check reverts to. */
const UNSPLIT_PROMPT = (capabilities: Capabilities, vision: boolean | undefined) =>
  sendsInlineImages(capabilities.imagesInline, vision)
    ? " Images attached to this turn are already in front of you: look at them directly and do not open image files with shell or file-read tools to see them."
    : " You are not shown attached images directly — an attachment reaches you only as the <attached-image path=…> reference in the message, so open that path with your file-read tool if you need to look at it.";

type Capabilities = { images?: boolean; imagesInline?: boolean };

const facts = (capabilities: Capabilities, vision: boolean | undefined) =>
  turnCapabilityFacts({
    instance: {
      driverKind: "claude",
      displayName: "Claude Code",
      models: { default: "m", options: [{ id: "m", label: "A Model" }] },
      adapter: { capabilities },
    },
    integrations: { agents: {} },
    providerRoute: { model: "m" },
    modelAcceptsImages: vision,
    peers: 0,
    memory: "off",
    imageProvider: false,
    canAskOwner: true,
  });

/** What the PRIMER's chosen line tells the bot about seeing the picture.
 * `inline` and `file-reference` both end with the bot looking at it; the
 * other three tell it to say it cannot see it and ask for a description. */
const primerSaysSighted = (imageInput: ImageInput) =>
  imageInput === "inline" || imageInput === "file-reference";

/** The same question of the turn's sentence. */
const promptSaysSighted = (sentence: string) => !/ask for a description/.test(sentence);

/** Every combination that can reach a live turn. `images` false with
 * `imagesInline` true is not a shape any driver declares, but the rule must
 * not depend on that. */
const MATRIX: ReadonlyArray<{ name: string; capabilities: Capabilities; vision: boolean | undefined }> = [
  { name: "claude/codex/acp, model sees", capabilities: { images: true, imagesInline: true }, vision: true },
  { name: "claude/codex/acp, vision unknown", capabilities: { images: true, imagesInline: true }, vision: undefined },
  { name: "claude/codex/acp, BYOK text-only model", capabilities: { images: true, imagesInline: true }, vision: false },
  { name: "pi/antigravity, model sees", capabilities: { images: true }, vision: true },
  { name: "pi/antigravity, vision unknown", capabilities: { images: true }, vision: undefined },
  { name: "pi/antigravity, BYOK text-only model", capabilities: { images: true }, vision: false },
  { name: "acp grok, model sees", capabilities: {}, vision: true },
  { name: "acp grok, vision unknown", capabilities: {}, vision: undefined },
  { name: "acp grok, BYOK text-only model", capabilities: {}, vision: false },
  { name: "incoherent driver: inline without images", capabilities: { imagesInline: true }, vision: true },
];

describe("the turn's image sentence agrees with the primer's", () => {
  it.each(MATRIX)("$name", ({ capabilities, vision }) => {
    const sentence = IMAGE_DELIVERY_PROMPT[imageDelivery(capabilities, vision)];
    expect(promptSaysSighted(sentence)).toBe(primerSaysSighted(facts(capabilities, vision).imageInput));
  });

  /** `ImageInput` declares a fifth state, `"unknown"`, whose line is "Murage
   *  cannot confirm whether you can see images here". No live turn reaches
   *  it: `turnCapabilityFacts` is a three-way ternary
   *  (unsupported / model-not-listed / inline|file-reference) with no branch
   *  that yields it, and index.ts:4933 is the only production caller of
   *  `capabilitiesPrimer`, always through those facts. This is a guard on the
   *  classifier ABOVE, not a claim about the primer lane's type: if the
   *  primer ever does start producing `"unknown"`, `primerSaysSighted` has to
   *  decide where it belongs, and this is what will say so. */
  it("never sees the unknown state the primer type still declares", () => {
    for (const row of MATRIX) expect(facts(row.capabilities, row.vision).imageInput).not.toBe("unknown");
  });

  // The asymmetry that makes the whole change worth having: `undefined` is
  // "Murage holds no catalog fact", which is every engine-managed model.
  // Reading it as "no" would put "ask for a description" on nearly every turn.
  it("does not treat unknown vision as no vision", () => {
    expect(IMAGE_DELIVERY_PROMPT[imageDelivery({ images: true, imagesInline: true }, undefined)]).not.toMatch(/ask for a description/);
    expect(IMAGE_DELIVERY_PROMPT[imageDelivery({ images: true }, undefined)]).toMatch(/open that path/);
  });

  // Never tell a bot to read a PNG into a context that cannot hold one.
  it.each([
    ["inline-capable driver, text-only model", { images: true, imagesInline: true } as Capabilities],
    ["path-only driver, text-only model", { images: true } as Capabilities],
    ["engine that takes no image at all", {} as Capabilities],
  ])("never tells an unsighted bot to open the file (%s)", (_name, capabilities) => {
    const sentence = IMAGE_DELIVERY_PROMPT[imageDelivery(capabilities, capabilities.images ? false : undefined)];
    expect(sentence).toMatch(/ask for a description/);
    expect(sentence).not.toMatch(/open that path|open image files/);
  });
});

/** The reproduction, kept as a test. Before the branch split these two rows
 * put "ask for a description" (primer) and "open that path" (turn) in one
 * prompt. If the unsplit expression ever comes back, this fails. */
describe("the two-branch sentence that shipped at 3127e0d9", () => {
  it.each([
    ["inline-capable driver on a BYOK text-only model", { images: true, imagesInline: true } as Capabilities, false],
    ["an engine that takes no image at all", {} as Capabilities, true],
  ])("contradicted the primer for %s", (_name, capabilities, vision) => {
    const old = UNSPLIT_PROMPT(capabilities, vision);
    expect(old).toMatch(/open that path/);
    expect(primerSaysSighted(facts(capabilities, vision).imageInput)).toBe(false);
    // …and the sentence that replaced it does not.
    expect(IMAGE_DELIVERY_PROMPT[imageDelivery(capabilities, vision)]).not.toMatch(/open that path/);
  });
});
