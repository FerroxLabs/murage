import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { e2eEnvironment } from "./e2e-environment.mjs";

describe("human fixture environment", () => {
  it("does not inherit provider, telemetry or arbitrary user credentials", () => {
    const env = e2eEnvironment({
      PATH: "/user/agents",
      HOME: "/real-user",
      FLUX_API_KEY: "private-flux-key",
      ANTHROPIC_API_KEY: "private-anthropic-key",
      VITE_POSTHOG_KEY: "private-telemetry-project",
      CUSTOM_SERVICE_SECRET: "private-service-key",
      MURAGE_COMPANION_DIR: "/real-companion",
      MURAGE_PORT: "32000",
    }, "/fixture", "/runtime/node");
    expect(JSON.stringify(env)).not.toContain("private-");
    expect(JSON.stringify(env)).not.toContain("/real-");
    expect(env.PATH).not.toContain("/user/agents");
    expect(env.MURAGE_PORT).toBe("32000");
    expect(env.HOME).toBe(join("/fixture", "fixture-home"));
    expect(env.MURAGE_DATA_DIR).toBe("/fixture");
  });

  it("retains explicitly selected ports and required platform bootstrap", () => {
    const env = e2eEnvironment({SYSTEMROOT: "system-root", WINDIR: "windows-dir", PATHEXT: ".EXE;.CMD", MURAGE_PORT: "32000", MURAGE_UI_PORT: "32002", MURAGE_WEBHOOK_PORT: "32001", LANG: "en_US.UTF-8"}, "/fixture");
    expect(env).toMatchObject({SYSTEMROOT: "system-root", WINDIR: "windows-dir", PATHEXT: ".EXE;.CMD", MURAGE_PORT: "32000", MURAGE_UI_PORT: "32002", MURAGE_WEBHOOK_PORT: "32001", LANG: "en_US.UTF-8", FAKE_CLAUDE_MODE: "happy"});
    expect(env.HERMES_HOME.startsWith(env.HOME)).toBe(true);
    expect(env.APPDATA.startsWith(env.HOME)).toBe(true);
  });
});
