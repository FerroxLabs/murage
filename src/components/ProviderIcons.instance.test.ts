// Upstream #4067: an engine that reports a provider mark shows it; one that does not keeps its driver's mark.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InstanceProviderMark, PresetProviderMark, ProviderMark } from "./ProviderIcons";
import { PROVIDER_ICON_PRESETS } from "../../shared/provider-icon";

const instance = (driverKind: string, icon?: { kind: "preset"; preset: (typeof PROVIDER_ICON_PRESETS)[number] }) =>
  renderToStaticMarkup(createElement(InstanceProviderMark, { instance: { driverKind, icon }, size: 18 }));

describe("an engine's mark", () => {
  it("is the provider's mark when the engine list carries one", () => {
    const deepseek = instance("openai-compat", { kind: "preset", preset: "deepseek" });
    expect(deepseek).toContain("#5786FE");
    expect(deepseek).toContain('width="18"');
    expect(deepseek).not.toContain(">O<");
  });

  it("reuses the mark Murage already draws for a provider it has an engine for", () => {
    expect(instance("openai-compat", { kind: "preset", preset: "anthropic" }))
      .toBe(renderToStaticMarkup(createElement(ProviderMark, { driverKind: "claudeAgent", size: 18 })));
    expect(instance("openai-compat", { kind: "preset", preset: "qwen" }))
      .toBe(renderToStaticMarkup(createElement(ProviderMark, { driverKind: "qwenAgent", size: 18 })));
  });

  it("keeps the driver's mark without one", () => {
    expect(instance("openai-compat")).toContain(">O<");
    expect(instance("fuigoAgent")).toBe(renderToStaticMarkup(createElement(ProviderMark, { driverKind: "fuigoAgent", size: 18 })));
  });

  it("draws every preset at the size it was asked for", () => {
    for (const preset of PROVIDER_ICON_PRESETS) {
      expect(renderToStaticMarkup(createElement(PresetProviderMark, { preset, size: 22 })), preset).toContain('width="22"');
    }
  });
});
