// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { plainEngineError } from "./plain-engine-error.ts";

describe("raw API errors read as plain sentences naming the bot (G11)", () => {
  it("names the bot and the picture when a provider refuses an image", () => {
    expect(plainEngineError("API error (status 400): {\"error\":{\"message\":\"image input is not supported for this model\",\"type\":\"invalid_request_error\"}}", "Dax"))
      .toBe("Dax's model can't read images, so it couldn't answer. Send the message again without the picture, or choose a model that reads images.");
    expect(plainEngineError("400 Bad Request: messages.0.content.1.image_url: unknown variant `image_url`", "Dax")).toMatch(/^Dax's model can't read images/);
  });

  it("says what kind of refusal it was without the provider's words", () => {
    expect(plainEngineError("API error (status 400): {\"error\":{\"type\":\"invalid_request_error\",\"message\":\"tools[3] schema invalid\"}}", "Dax"))
      .toBe("Dax's model provider turned this request down. The details below say why.");
    expect(plainEngineError("HTTP 404: model `deepseek-v9` does not exist", "Dax")).toBe("Dax's model isn't available from its provider. Choose another model for Dax.");
    expect(plainEngineError("API error (status 502 Bad Gateway): upstream connect error", "Dax")).toBe("Dax's model provider had a problem on its side. Try again in a moment.");
    expect(plainEngineError("API error (status 400): prompt is too long: 250000 tokens > 200000 maximum", "Dax")).toBe("This conversation is too long for Dax's model. Start a new conversation, or choose a model with a larger context.");
    expect(plainEngineError("{\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"}}", "Dax")).toBe("Dax's model provider had a problem on its side. Try again in a moment.");
  });

  it("leaves Murage's own plain sentences alone", () => {
    expect(plainEngineError("Could not reach 192.168.1.50:11434: nothing answered there. Check that the server is running and that its address is right.", "Dax")).toBeUndefined();
    expect(plainEngineError("Selected provider connection changed before dispatch", "Dax")).toBeUndefined();
    expect(plainEngineError("", "Dax")).toBeUndefined();
  });
});

describe("audit round (0.1.61 polish)", () => {
  it("says a model can't read images only when the provider says so", () => {
    expect(plainEngineError("API error (status 400): Invalid image data", "Dax"))
      .toBe("Dax's model provider couldn't use the picture. Send it again, or send the message without it.");
    expect(plainEngineError("API error (status 400): flux-pinned-deepseek-v4-pro does not accept image input", "Dax")).toMatch(/^Dax's model can't read images/);
  });

  it("puts a too-long conversation before any mention of images", () => {
    expect(plainEngineError("API error (status 400): maximum context length exceeded; image tokens count toward the total", "Dax"))
      .toBe("This conversation is too long for Dax's model. Start a new conversation, or choose a model with a larger context.");
  });

  it("does not promise details where there are none", () => {
    expect(plainEngineError("API error (status 400): tools[3] schema invalid", "Dax", { details: false })).toBe("Dax's model provider turned this request down.");
  });
});
