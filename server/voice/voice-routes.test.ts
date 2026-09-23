import { describe, expect, it } from "vitest";

import { describeVoiceRoutes, voiceEndpoint } from "./voice-routes.ts";
import type { ProviderPreset } from "../../shared/provider-connections.ts";

const BASE: Record<string, string> = {
  flux: "https://api.fluxrouter.ai/v1",
  xai: "https://api.x.ai/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  groq: "https://api.groq.com/openai/v1",
};

function source(rows: Array<{ id: string; preset: ProviderPreset; enabled?: boolean; key?: string }>) {
  return {
    list: () => rows.map((r) => ({ id: r.id, preset: r.preset, label: r.id, enabled: r.enabled ?? true })),
    resolve: (id: string) => {
      const row = rows.find((r) => r.id === id);
      return row ? { baseUrl: BASE[row.preset], key: row.key ?? `${row.id}-key`, preset: row.preset, label: row.id } : null;
    },
  };
}

describe("where each part of a call runs", () => {
  it("uses Flux for everything when a Flux key exists", () => {
    const s = source([{ id: "flux", preset: "flux" }, { id: "x", preset: "xai" }, { id: "o", preset: "openai" }]);
    expect(describeVoiceRoutes(s)).toEqual({ host: "flux", lookup: "flux", speech: "flux", transcribe: "flux" });
    expect(voiceEndpoint("host", s)).toMatchObject({ via: "flux", model: "claude-haiku-4-5", key: "flux-key" });
  });

  it("without Flux, each part falls to the owner's own keys that can serve it", () => {
    const s = source([{ id: "x", preset: "xai" }, { id: "o", preset: "openai" }, { id: "g", preset: "groq" }]);
    expect(describeVoiceRoutes(s)).toEqual({ host: "xai", lookup: "xai", speech: "openai", transcribe: "groq" });
    expect(voiceEndpoint("speech", s)).toMatchObject({ via: "openai", model: "gpt-4o-mini-tts", baseUrl: "https://api.openai.com/v1" });
  });

  it("gives Anthropic its /v1 path and a Haiku host", () => {
    const s = source([{ id: "a", preset: "anthropic" }]);
    expect(voiceEndpoint("host", s)).toMatchObject({ via: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5" });
    expect(describeVoiceRoutes(s)).toEqual({ host: "anthropic", lookup: "anthropic", speech: null, transcribe: null });
  });

  it("skips disabled connections and empty keys, and reports nothing when nothing serves", () => {
    const s = source([{ id: "f", preset: "flux", enabled: false }, { id: "x", preset: "xai", key: " " }]);
    expect(describeVoiceRoutes(s)).toEqual({ host: null, lookup: null, speech: null, transcribe: null });
  });
});
