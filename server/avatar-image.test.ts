import { describe, expect, it, vi } from "vitest";

import {
  avatarGenerationStateMatches,
  avatarGenerationPrompt,
  avatarGenerationRequestSchema,
  avatarImageMime,
  generateAvatarImage,
  resolveAvatarImageRoutes,
  snapshotAvatarGenerationState,
  AVATAR_IMAGE_TIMEOUT_MS,
  FLUX_IMAGE_ARM,
  FLUX_IMAGE_MODEL,
  FLUX_IMAGE_TIER_NOT_AN_ALIAS,
  FLUX_IMAGE_URL,
} from "./avatar-image.ts";

const BOT = { name: "Scout", title: "Research agent", description: "Finds evidence quickly." };

/** Real magic bytes. The mime is read off the bytes now, so a fixture that is
 *  not actually an image would be rejected — as it should be. */
const webp = (): Buffer => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPdrawn")]);
const png = (): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("drawn")]);

const imageResponse = (bytes: Buffer, status = 200) =>
  new Response(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** generateAvatarImage takes the Flux key last, and it defaults to fluxKey().
 *  Every test names it, so none of them depends on the developer's own env. */
const generate = (
  openAiKey: string,
  fetchImpl: typeof fetch,
  fluxApiKey: string | null,
  timeoutMs = AVATAR_IMAGE_TIMEOUT_MS,
) => generateAvatarImage(openAiKey, BOT, "blue robot", fetchImpl, timeoutMs, fluxApiKey);

describe("avatar image generation", () => {
  it("bounds free-form direction and keeps the crop brief", () => {
    expect(avatarGenerationRequestSchema.safeParse({ prompt: "x".repeat(401) }).success).toBe(false);
    const prompt = avatarGenerationPrompt(BOT, "navy owl with a brass compass");
    expect(prompt).toContain("center 70%");
    expect(prompt).toContain('"navy owl with a brass compass"');
    expect(prompt).toContain("No words");
  });

  it("detects an avatar edit made after generation starts", () => {
    const mutable = { avatarUrl: "/api/attachments/old.webp", avatarCrop: "circle" as const };
    const initial = snapshotAvatarGenerationState(mutable);

    mutable.avatarUrl = "/api/attachments/new.webp";

    expect(avatarGenerationStateMatches(initial, mutable)).toBe(false);
    expect(initial).toEqual({ avatarUrl: "/api/attachments/old.webp", avatarCrop: "circle" });
  });

  it("uses one low-quality square GPT Image 2 request and decodes WebP bytes", async () => {
    const bytes = webp();
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse(bytes));

    const result = await generate("sk-image", fetchMock, null);
    expect(result).toEqual({ bytes, mime: "image/webp", provider: "openai", model: "gpt-image-2" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(init?.headers).toMatchObject({ authorization: "Bearer sk-image" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "low",
      output_format: "webp",
    });
  });

  it("never exposes malformed upstream bodies as image data", async () => {
    const malformed = vi.fn<typeof fetch>(async () => new Response('{"data":[]}', { status: 200 }));
    await expect(generate("sk-image", malformed, null)).rejects.toThrow("no generated image");
  });

  it("cancels an upstream response as soon as it exceeds the byte cap", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 20) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const oversized = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));

    await expect(generate("sk-image", oversized, null)).rejects.toThrow("exceeded the response limit");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(20);
  });

  it("normalizes a timeout that fires while reading a hanging response body", async () => {
    const hanging = vi.fn<typeof fetch>(async (_url, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    });

    await expect(generate("sk-image", hanging, null, 10)).rejects.toMatchObject({
      message: "Avatar generation timed out",
      status: 502,
    });
  });
});

describe("which provider draws the avatar", () => {
  it("puts Flux first and keeps the user's own OpenAI key as the fallback", () => {
    // ONE resolver. Every caller gets this order or gets an error; no call site
    // is allowed its own opinion about which key wins.
    expect(resolveAvatarImageRoutes("sk-image", "flux-live").map((route) => route.provider)).toEqual([
      "flux",
      "openai",
    ]);
    expect(resolveAvatarImageRoutes("sk-image", null).map((route) => route.provider)).toEqual(["openai"]);
    expect(resolveAvatarImageRoutes("", "flux-live").map((route) => route.provider)).toEqual(["flux"]);
    // Whitespace is not a key.
    expect(resolveAvatarImageRoutes("sk-image", "   ").map((route) => route.provider)).toEqual(["openai"]);
  });

  it("names BOTH places it looked when there is no key at all", () => {
    // resolveFuigoCli's rule: "add a key" is useless advice when there are two
    // of them and the message does not say which two.
    let thrown: unknown;
    try {
      resolveAvatarImageRoutes("  ", null);
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain("Flux Router key");
    expect(message).toContain("FLUX_API_KEY");
    expect(message).toContain("OpenAI image key");
    expect(message).toContain("MURAGE_OPENAI_IMAGE_KEY");
    expect((thrown as { status?: number }).status).toBe(409);
  });

  it("posts a Flux avatar at the metered image route, on a named arm", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse(png()));
    const result = await generate("sk-image", fetchMock, "flux-live-key");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.fluxrouter.ai/v1/images/generations");
    expect(url).toBe(FLUX_IMAGE_URL);
    expect(init?.headers).toMatchObject({ authorization: "Bearer flux-live-key" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "flux-image-gpt",
      size: "1024x1024",
      n: 1,
      response_format: "b64_json",
    });
    // The picture is PNG whatever we asked for, because the Flux route forwards
    // no output_format. The mime is read off the bytes, not off the request.
    expect(result.mime).toBe("image/png");
    expect(result).toMatchObject({ provider: "flux", model: "flux-image-gpt" });
  });

  it("never sends the id that silently degrades to the cheapest arm", async () => {
    // `flux-image` is a BILLING TIER, not an alias (customer_pricing.py:117 vs
    // capability_image.py:89). Sent as `model` it resolves to None, falls
    // through to the Standard canonical, and Standard is pinned to
    // together-flux — the cheapest of seven arms — with a 200 and no warning.
    // A NAMED alias cannot do that: an unroutable explicit pick is a 400.
    expect(FLUX_IMAGE_MODEL).not.toBe(FLUX_IMAGE_TIER_NOT_AN_ALIAS);
    expect(FLUX_IMAGE_MODEL).toBe("flux-image-gpt");
    expect(FLUX_IMAGE_ARM).toBe("gpt-image-med");

    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse(png()));
    await generate("sk-image", fetchMock, "flux-live-key");
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { model: string };
    expect(sent.model).not.toBe("flux-image");
  });

  it("falls back to the user's own OpenAI key when Flux says this account may not", async () => {
    // 402 premium_locked: the image capability is entitled to paid, cleared
    // accounts only (images_route.py). Somebody who was generating avatars
    // yesterday on their own OpenAI key must not lose that by adding Flux.
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("fluxrouter")
        ? new Response('{"error":{"message":"image generation requires a paid plan","code":"premium_locked"}}', {
            status: 402,
          })
        : imageResponse(webp()),
    );

    const result = await generate("sk-image", fetchMock, "flux-live-key");
    expect(result).toMatchObject({ provider: "openai", mime: "image/webp" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.fluxrouter.ai/v1/images/generations",
      "https://api.openai.com/v1/images/generations",
    ]);
  });

  it("does not quietly move the bill when Flux merely breaks", async () => {
    // A 502 is transient. Retrying it on the other account would charge a
    // different provider for a blip and hide the outage.
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"error":{"message":"image provider error"}}', { status: 502 }));

    await expect(generate("sk-image", fetchMock, "flux-live-key")).rejects.toThrow("Flux Router");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("surfaces the real reason when Flux is the only route", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('{"error":{"message":"image generation requires a paid plan"}}', { status: 402 }),
    );

    await expect(generate("", fetchMock, "flux-live-key")).rejects.toThrow("requires a paid plan");
  });
});

describe("the mime is read off the bytes", () => {
  it("recognises what saveImage can store, and only that", () => {
    expect(avatarImageMime(webp())).toBe("image/webp");
    expect(avatarImageMime(png())).toBe("image/png");
    expect(avatarImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
    expect(avatarImageMime(Buffer.from("GIF89a-frames"))).toBe("image/gif");
    // POSITIVE control for the negative case: prove the sniffer says no.
    expect(avatarImageMime(Buffer.from("<svg/>"))).toBe(null);
    expect(avatarImageMime(Buffer.from("RIFFxxxxAVI "))).toBe(null);
  });

  it("refuses a provider payload that is not an image Murage can store", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse(Buffer.from("<svg onload=alert(1)>")));
    await expect(generate("sk-image", fetchMock, null)).rejects.toThrow("cannot store");
  });
});
