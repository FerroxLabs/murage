import { describe, expect, it } from "vitest";

import { imageDeliveryOutcome, IMAGE_DELIVERY_PROMPT, sendsInlineImages, unboundImagePolicy } from "./turn-image-dispatch.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { CodexDriver } from "./drivers/codex.ts";
import { PiDriver } from "./drivers/pi.ts";
import { AntigravityDriver } from "./drivers/antigravity.ts";

describe("sendsInlineImages", () => {
  it("sends the picture to an engine that carries it", () => {
    expect(sendsInlineImages(true, undefined)).toBe(true);
    expect(sendsInlineImages(true, true)).toBe(true);
  });

  // pi and Antigravity: the composer may offer an attachment (capabilities
  // .images) but neither protocol takes one, so the turn keeps the
  // <attached-image path=…> reference and sends no bytes.
  it("falls back to the path reference for an engine that cannot carry one", () => {
    expect(sendsInlineImages(false, true)).toBe(false);
    expect(sendsInlineImages(undefined, true)).toBe(false);
  });

  // A BYOK catalog that says this model has no vision. Sending it an image
  // is at best wasted bytes and at worst a 400 that kills the turn.
  it("sends no image to a vision-less model even on an image-capable engine", () => {
    expect(sendsInlineImages(true, false)).toBe(false);
  });

  // `undefined` is "Murage holds no vision fact", which is every
  // engine-managed model. Reading it as "no" would have quietly undone the
  // whole change for nearly every turn.
  it("does not treat an unknown model as vision-less", () => {
    expect(sendsInlineImages(true, undefined)).toBe(true);
  });
});

/** The capability each driver declares is the whole input to the rule above,
 *  so a driver that stops consuming `turn.images` — or starts claiming it
 *  does without wiring it — is caught here rather than in a bot describing a
 *  picture it never saw. */
describe("declared driver image capabilities", () => {
  const capabilities = async (driver: typeof ClaudeDriver | typeof CodexDriver | typeof PiDriver | typeof AntigravityDriver) => {
    const instance = await driver.create({
      instanceId: `cap-${driver.driverKind}`,
      displayName: driver.metadata.displayName,
      enabled: true,
      config: driver.defaultConfig(),
      environment: {},
    } as never);
    const declared = instance.adapter.capabilities;
    await instance.dispose?.();
    return declared;
  };

  it.each([
    ["claude", ClaudeDriver, true],
    ["codex", CodexDriver, true],
    ["pi", PiDriver, false],
    ["antigravity", AntigravityDriver, false],
  ] as const)("%s carries images inline: %s", async (_name, driver, inline) => {
    const declared = await capabilities(driver);
    // Every one of these four offers image attachments in the composer …
    expect(declared.images).toBe(true);
    // … but only the two whose protocol takes an image is shown one.
    expect(declared.imagesInline === true).toBe(inline);
  });
});


describe("unboundImagePolicy", () => {
  // Fuigo refused an unbound tag since it could first inline; nothing else
  // ever reached that read before 0.1.55. Each keeps what it shipped with.
  it("keeps the turn-refusing form only where it already shipped", () => {
    expect(unboundImagePolicy("fuigoAgent")).toBe("refuse");
    for (const kind of ["claude", "codex", "cursor", "gemini", "qwen", "kimi", "hermes", "opencode-go", "droid", "custom"]) {
      expect(unboundImagePolicy(kind), kind).toBe("path");
    }
  });
});

describe("imageDeliveryOutcome", () => {
  const image = { mimeType: "image/png", data: "x" };
  it("leaves an inline plan alone when every tag was bound", () => {
    expect(imageDeliveryOutcome("inline", { images: [image], unbound: [] })).toBe("inline");
    expect(imageDeliveryOutcome("inline", { images: [], unbound: [] })).toBe("inline");
    expect(imageDeliveryOutcome("inline", undefined)).toBe("inline");
  });
  // The regression: an inline engine on an unbound tag. Nothing is inlined,
  // the turn goes on, and the bot is told it has a path, not a picture.
  it("downgrades an inline plan to path when nothing could be bound", () => {
    expect(imageDeliveryOutcome("inline", { images: [], unbound: ["/a.png"] })).toBe("path");
  });
  it("reports mixed when some tags were bound and some were not", () => {
    expect(imageDeliveryOutcome("inline", { images: [image], unbound: ["/a.png"] })).toBe("mixed");
  });
  // Only an inline plan can be revised: nothing was ever going to be inlined
  // on a path engine, and an unsighted bot is unsighted whatever the tags say.
  it("never revises a path or unsighted plan", () => {
    expect(imageDeliveryOutcome("path", { images: [], unbound: ["/a.png"] })).toBe("path");
    expect(imageDeliveryOutcome("unsighted", { images: [image], unbound: ["/a.png"] })).toBe("unsighted");
  });
  it("tells a downgraded or mixed bot to open the path, never that the picture is in front of it", () => {
    for (const outcome of ["path", "mixed"] as const) {
      expect(IMAGE_DELIVERY_PROMPT[outcome]).toMatch(/open .* with your file-read tool/);
      expect(IMAGE_DELIVERY_PROMPT[outcome]).not.toMatch(/ask for a description/);
    }
    expect(IMAGE_DELIVERY_PROMPT.mixed).toMatch(/cannot see reached you only as that path/);
    expect(IMAGE_DELIVERY_PROMPT.path).not.toMatch(/already in front of you/);
  });
});
