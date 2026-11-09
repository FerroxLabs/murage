import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F9 (upstream af59c2ec4, #3740): GitHub Copilot CLI as a built-in ACP engine. The scripted fake ACP CLI stands
// in for `copilot --acp --stdio`; no real Copilot binary or ~/.copilot is touched, and every token is fake.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { allInstanceConfigs, ensureDirs, type AppConfig } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { DEFAULT_INSTANCES } from "../../default-instances.ts";
import { ENGINE_SIGNIN_TABLE } from "../../engine-signin-recipe.ts";
import { driverMountsPhoneJobs } from "../../phone-jobs-engines.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import {
  classifyCopilotError, COPILOT_DEFAULT_MODEL, COPILOT_INSTALL_URL, COPILOT_SPAWN_ARGS, CopilotAgentDriver, copilotSupport,
} from "./copilot.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("GitHub Copilot as a built-in engine", () => {
  it("is registered after every existing engine, and Fuigo stays first", () => {
    const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
    expect(kinds[0]).toBe("fuigoAgent");
    expect(kinds.at(-1)).toBe("copilotAgent");
    expect(kinds.filter((kind) => kind === "copilotAgent")).toHaveLength(1);
  });

  it("joins the default and product fleets last, never ahead of Fuigo", () => {
    const fresh = Object.keys(DEFAULT_INSTANCES);
    expect(fresh[0]).toBe("fuigo");
    expect(fresh.at(-1)).toBe("githubCopilot");
    expect(DEFAULT_INSTANCES.githubCopilot).toEqual({ driver: "copilotAgent" });
    // An existing install's own fleet picks the engine up as a later addition, after what it already has.
    const existing = allInstanceConfigs({ instances: { claude: { driver: "claudeAgent" }, fuigo: { driver: "fuigoAgent" } } } as unknown as AppConfig);
    const ids = Object.keys(existing);
    expect(ids.slice(0, 2)).toEqual(["claude", "fuigo"]);
    expect(ids.at(-1)).toBe("githubCopilot");
    expect(existing.githubCopilot?.driver).toBe("copilotAgent");
  });

  it("launches the person's own `copilot --acp --stdio`, and never installs it", () => {
    expect(copilotSupport.defaultCli).toBe("copilot");
    expect(COPILOT_SPAWN_ARGS).toEqual(["--acp", "--stdio"]);
    expect(copilotSupport.spawnArgs({ cli: "copilot" } as never, { threadId: "t", text: "hi" } as never)).toEqual(["--acp", "--stdio"]);
    // No install command: the setup card can only link GitHub's own instructions.
    expect(copilotSupport.install?.command).toBeUndefined();
    expect(copilotSupport.install?.native).toBeUndefined();
    expect(copilotSupport.install?.docsUrl).toBe(COPILOT_INSTALL_URL);
    expect(new URL(COPILOT_INSTALL_URL).hostname).toBe("docs.github.com");
    expect(copilotSupport.install?.signInCommand).toBe("copilot login");
    expect(ENGINE_SIGNIN_TABLE.copilotAgent).toMatchObject({ kind: "terminal", args: ["login"] });
    expect(driverMountsPhoneJobs("copilotAgent")).toBe(true);
    // The model stays Copilot's own choice: one passthrough id, nothing pinned over ACP.
    expect(copilotSupport.models).toEqual({ default: COPILOT_DEFAULT_MODEL, options: [{ id: COPILOT_DEFAULT_MODEL, label: "Copilot default" }] });
    expect(copilotSupport.selectModel).toBeUndefined();
  });

  it("does not claim a sign-in it cannot see, and never starts Copilot to ask", async () => {
    expect(await copilotSupport.isAuthenticated({}, { cli: "copilot" } as never)).toBeUndefined();
    expect(copilotSupport.authUnknownIsUnverified).toBe(true);
    expect(copilotSupport.resolveModels).toBeUndefined();
  });

  it("reads only whole login refusals as a missing sign-in", () => {
    for (const message of ["Authentication required", "Not logged in. Run `copilot login`.", "Bad credentials", "GitHub token has expired", "Unauthorized"]) {
      expect(classifyCopilotError({ code: -32000, message }), message).toBe("invalid_credentials");
    }
    for (const message of ["max tokens exceeded", "the author field is missing", "MCP server github: missing token", "rate limited"]) {
      expect(classifyCopilotError({ code: -32000, message }), message).toBeUndefined();
    }
    expect(classifyCopilotError({ code: -32603, message: "Authentication required" })).toBeUndefined();
  });

  it("drops the allow-all switch and general GitHub tokens, keeping Copilot's own token", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/bin", copilot_allow_all: "1", GH_TOKEN: "fake-gh", GITHUB_TOKEN: "fake-github", COPILOT_GITHUB_TOKEN: "fake-copilot",
    };
    copilotSupport.transformEnv!(env, { cli: "copilot" } as never);
    expect(env).toEqual({ PATH: "/bin", COPILOT_GITHUB_TOKEN: "fake-copilot" });
  });

  it("drops them from the owner's captured shell map too, where this process never had them (Astra r1 High)", () => {
    const handed: Record<string, string | undefined> = {
      PATH: "/bin", COPILOT_ALLOW_ALL: "true", gh_token: "fake-gh", GITHUB_TOKEN: "fake-github", COPILOT_GITHUB_TOKEN: "fake-copilot", HOME: "/h",
    };
    expect(copilotSupport.scrubHandedEnv).toBeTypeOf("function");
    copilotSupport.scrubHandedEnv!(handed, { PATH: "/bin" });
    expect(handed).toEqual({ PATH: "/bin", COPILOT_GITHUB_TOKEN: "fake-copilot", HOME: "/h" });
  });
});

describe("a GitHub Copilot turn through the fake ACP CLI", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  const create = async (environment: Record<string, string> = {}) => {
    instance = await CopilotAgentDriver.create({
      instanceId: "githubCopilot",
      displayName: "GitHub Copilot",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };
  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-copilot-acp-test-"));
  });
  afterEach(async () => {
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.FAKE_ACP_MODE;
    delete process.env.GH_TOKEN;
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeTempDir(scratch);
  });

  it("runs with --acp --stdio, without the allow-all switch or a general GitHub token", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.GH_TOKEN = "fake-server-gh-token";
    await create({ COPILOT_ALLOW_ALL: "true", GITHUB_TOKEN: "fake-instance-github-token", COPILOT_GITHUB_TOKEN: "fake-copilot-token" });
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-copilot", text: "hi" });
    expect(await recorder!.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    const state = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string | undefined> };
    expect(state.argv).toEqual(expect.arrayContaining(["--acp", "--stdio"]));
    expect(state.env.COPILOT_ALLOW_ALL).toBeUndefined();
    expect(state.env.GH_TOKEN).toBeUndefined();
    expect(state.env.GITHUB_TOKEN).toBeUndefined();
    expect(state.env.COPILOT_GITHUB_TOKEN).toBe("fake-copilot-token");
  });

  it("a refused login ends the turn as a sign-in step, not a retry", async () => {
    process.env.FAKE_ACP_MODE = "auth-required";
    await create();
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-copilot-login", text: "hi" });
    expect(await recorder!.until((event) => event.type === "turn.completed")).toMatchObject({ ok: false });
    expect(recorder!.events).toContainEqual(expect.objectContaining({ type: "runtime.error", setup: true }));
  });
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
