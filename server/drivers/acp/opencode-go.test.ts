import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import {
  classifyOpenCodeGoError,
  createOpenCodeGoDriver,
  fetchOpenCodeGoModels,
  resetOpenCodeGoModelCache,
} from "./opencode-go.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("OpenCode Go catalog", () => {
  beforeEach(() => resetOpenCodeGoModelCache());

  it("normalizes valid catalog records to provider-qualified model ids", async () => {
    const models = await fetchOpenCodeGoModels(async () =>
      new Response(JSON.stringify({
        data: [
          { id: "minimax-m3", object: "model" },
          { id: "ox-alpha-free", object: "model" },
          { id: "bad id", object: "model" },
          { object: "model" },
        ],
      }), { status: 200 }),
    );

    expect(models.default).toBe("opencode-go/minimax-m3");
    expect(models.options.map((option) => option.id)).toEqual([
      "opencode-go/minimax-m3",
      "opencode-go/kimi-k3",
      "opencode-go/glm-5.2",
      "opencode-go/ox-alpha-free",
    ]);
    expect(models.options.some((option) => option.custom)).toBe(false);
  });

  it("uses the last successful catalog when the endpoint fails", async () => {
    const fetcher = async () =>
      new Response(JSON.stringify([{ id: "kimi-k3" }, { id: "extra-live" }]), { status: 200 });
    await fetchOpenCodeGoModels(fetcher);

    const fallback = await fetchOpenCodeGoModels(async () => {
      throw new Error("network down");
    });

    expect(fallback.default).toBe("opencode-go/minimax-m3");
    expect(fallback.options.some((option) => option.id === "opencode-go/extra-live" && !option.custom)).toBe(true);
  });

  it("refreshes the same instance catalog on each explicit refresh", async () => {
    let calls = 0;
    const driver = createOpenCodeGoDriver(async () => {
      calls += 1;
      const id = calls === 1 ? "minimax-m3" : calls === 2 ? "extra-two" : "extra-three";
      return new Response(JSON.stringify([{ id }]), { status: 200 });
    });
    const instance = await driver.create({
      instanceId: "opencode-refresh",
      displayName: "OpenCode Go",
      environment: {},
      enabled: true,
      config: driver.defaultConfig(),
    });

    expect(instance.models.default).toBe("opencode-go/minimax-m3");
    expect(instance.models.options.some((option) => option.custom)).toBe(false);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "opencode-go/extra-two" && !option.custom)).toBe(true);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "opencode-go/extra-three" && !option.custom)).toBe(true);
    await instance.dispose();
  });

  it("keeps the driver optional and declares the OpenCode CLI setup", () => {
    const driver = createOpenCodeGoDriver(async () => new Response("[]", { status: 200 }));
    expect(driver.driverKind).toBe("opencodeGo");
    expect(driver.decodeConfig(undefined)).toEqual({ cli: "opencode", fullAuto: false, workspace: undefined });
    expect(driver.install?.docsUrl).toContain("opencode.ai");
    expect(driver.install?.signInCommand).toBe("opencode auth login --provider opencode-go");
  });

  it("recognizes an OpenCode Go login stored by the CLI", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-auth-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "stored-secret" },
    }));
    const driver = createOpenCodeGoDriver(async () => new Response("[]", { status: 200 }));
    const instance = await driver.create({
      instanceId: "opencode-auth",
      displayName: "OpenCode Go",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("finds the CLI's login at ~/.local/share on every platform, macOS included", async () => {
    // `opencode auth list` prints ~/.local/share/opencode/auth.json on macOS —
    // the CLI is xdg-flavoured everywhere. Looking only in Library/Application
    // Support is the bug that told signed-in users to sign in. No XDG override
    // here on purpose: this is the exact real-world shape.
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-home-"));
    const authDir = join(scratch, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "stored-secret" },
    }));
    const driver = createOpenCodeGoDriver(async () => new Response("[]", { status: 200 }));
    const instance = await driver.create({
      instanceId: "opencode-home-auth",
      displayName: "OpenCode Go",
      environment: { HOME: scratch, USERPROFILE: scratch, XDG_DATA_HOME: "", OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("does not mistake an OpenCode Zen login for OpenCode Go", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-oauth-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      opencode: { type: "oauth", access: "acc-token", refresh: "ref-token" },
    }));
    const driver = createOpenCodeGoDriver(async () => new Response("[]", { status: 200 }));
    const instance = await driver.create({
      instanceId: "opencode-oauth-auth",
      displayName: "OpenCode Go",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(false);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("shows setup before spawning a Go turn when only Zen is connected", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-zen-only-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      opencode: { type: "api", key: "zen-only-secret" },
    }));
    const driver = createOpenCodeGoDriver(async () => new Response("[]", { status: 200 }));
    const instance = await driver.create({
      instanceId: "opencode-zen-only",
      displayName: "OpenCode Go",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-opencode-zen-only",
        text: "hello",
        model: "opencode-go/ox-alpha-free",
      });
      const done = await recorder.until((event) => event.type === "turn.completed");
      expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
      expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({
        setup: true,
        message: expect.stringContaining("--provider opencode-go"),
      });
      expect(recorder.events.some((event) => event.type === "session.started")).toBe(false);
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("classifies ACP's standard authentication error", () => {
    expect(classifyOpenCodeGoError({ code: -32000 })).toBe("invalid_credentials");
  });

  it("keeps the OpenCode key in the child environment only", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-go-"));
    try {
      const dump = join(scratch, "env.json");
      const driver = createOpenCodeGoDriver(async () => new Response(JSON.stringify([{ id: "minimax-m3" }]), { status: 200 }));
      const instance = await driver.create({
        instanceId: "opencode-go",
        displayName: "OpenCode Go",
        environment: {
          OPENCODE_API_KEY: "secret-value",
          OPENAI_API_KEY: "wrong-provider-secret",
          ANTHROPIC_API_KEY: "wrong-provider-secret",
          FAKE_ACP_DUMP: dump,
        },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      await instance.snapshot();
      const child = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
      expect(child.env.OPENCODE_API_KEY).toBe("secret-value");
      expect(child.env.OPENAI_API_KEY).toBeUndefined();
      expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
      await instance.dispose();
    } finally {
      await removeTempDir(scratch);
    }
  });
});
