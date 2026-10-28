import { describe, expect, it } from "vitest";
import { ENGINE_LABEL } from "../server/conversation-deletion.ts";
import { aiProviderName } from "./phone-ai-provider.ts";

const FIXED: Record<string, string> = {
  claude: "Anthropic", claudeAgent: "Anthropic", codex: "OpenAI", geminiAgent: "Google", antigravityAgent: "Google",
  grokAgent: "xAI", kimiAgent: "Moonshot AI", qwenAgent: "Alibaba Cloud", cursorAgent: "Cursor", droidAgent: "Factory",
};
const ROUTERS = ["fuigoAgent", "piAgent", "opencodeGo", "hermesAgent", "openclawAgent", "clineAgent", "customAcp"];

describe("aiProviderName", () => {
  it("covers every engine kind the app labels", () => {
    for (const kind of Object.keys(ENGINE_LABEL)) expect(kind in FIXED || ROUTERS.includes(kind), kind).toBe(true);
  });
  it("a fixed-vendor engine names its company whatever the model or host", () => {
    for (const [kind, name] of Object.entries(FIXED)) {
      expect(aiProviderName(kind).name).toBe(name);
      expect(aiProviderName(kind, { model: "deepseek-chat", endpointHost: "evil.example.com" }).name).toBe(name);
    }
    expect(aiProviderName("claude")).toEqual({ id: "anthropic", name: "Anthropic" });
    expect(aiProviderName("grokAgent", { model: "claude-sonnet-4" }).name).toBe("xAI");
  });
  it("a router names the model's maker", () => {
    expect(aiProviderName("fuigoAgent", { model: "claude-sonnet-4" }).name).toBe("Anthropic");
    expect(aiProviderName("fuigoAgent", { model: "openrouter/deepseek-chat" }).name).toBe("DeepSeek");
    expect(aiProviderName("piAgent", { model: "GPT-5" }).name).toBe("OpenAI");
    expect(aiProviderName("hermesAgent", { model: "meta/llama-3" }).name).toBe("Meta");
    expect(aiProviderName("clineAgent", { model: "zai/glm-4.6" }).name).toBe("Zhipu AI");
    expect(aiProviderName("customAcp", { model: "codestral-latest" }).name).toBe("Mistral AI");
    expect(aiProviderName("opencodeGo", { model: "o3-mini" }).name).toBe("OpenAI");
  });
  it("a router with an unknown model names the host", () => {
    expect(aiProviderName("fuigoAgent", { model: "my-model", endpointHost: "LLM.Internal.example:8080" })).toEqual({
      id: "host:llm.internal.example", name: "llm.internal.example",
    });
    expect(aiProviderName("somethingNew", { endpointHost: "api.example.com" }).name).toBe("api.example.com");
  });
  it("with no model and no host the name is neutral", () => {
    for (const kind of [...ROUTERS, "somethingNew"]) {
      expect(aiProviderName(kind)).toEqual({ id: "unknown", name: "another AI service" });
    }
    expect(aiProviderName("fuigoAgent", { model: " ", endpointHost: "  " }).id).toBe("unknown");
  });
  it("never returns Ferrox Labs; bounds id and name; no em dash", () => {
    for (const kind of [...Object.keys(ENGINE_LABEL), "x"]) {
      const r = aiProviderName(kind, { model: "ferrox-1" });
      expect(r.name).not.toMatch(/ferrox/i);
      expect(r.name).not.toMatch(/—/);
    }
    const r = aiProviderName("x", { endpointHost: "a".repeat(300) + ".com" });
    expect(r.id.length).toBeLessThanOrEqual(64);
    expect(r.name.length).toBeLessThanOrEqual(120);
  });
});
