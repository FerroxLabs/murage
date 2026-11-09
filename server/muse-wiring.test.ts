import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GAP-MUSE wiring (BRIEF-1016-MUSE-BUILD.md, Builder B): everything around the museCode driver that is not the
// driver itself. The Meta key stays with Muse Code alone, Muse Code is hidden on Cloud and never routes through Flux,
// it sits after Cline with Fuigo still first, and the shared engine tables all know its name. The fake ACP CLI stands
// in for another engine; no Muse CLI is installed or run anywhere in this file. Every key below is fake.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLOUD_HIDDEN_ENGINES, isCloudHiddenEngine } from "./cloud-home/runnable-engines.ts";
import { allInstanceConfigs, ensureDirs, instanceConfigs, PROVIDER_CREDENTIAL_ENV, stripCliProbeCredentialEnv, stripWorkspaceCredentialEnv, WORKSPACE_CREDENTIAL_ENV, type AppConfig } from "./config.ts";
import type { ProviderInstance } from "./contracts.ts";
import { ENGINE_LABEL } from "./conversation-deletion.ts";
import { DEFAULT_INSTANCES } from "./default-instances.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { CustomAcpDriver } from "./drivers/acp/custom.ts";
import { ENGINE_SIGNIN_TABLE } from "./engine-signin-recipe.ts";
import { augmentedPath, resetPathCacheForTests } from "./env-path.ts";
import { fluxSurfaceFor } from "./flux-routing.ts";
import { driverMountsPhoneJobs, PHONE_JOBS_ENGINES } from "./phone-jobs-engines.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const META_KEY = "fake-meta-key-MMMM4444"; // secret-scan: fixture

describe("the Meta key stays with Muse Code", () => {
  it("is on both strip lists", () => {
    expect(PROVIDER_CREDENTIAL_ENV).toContain("META_API_KEY");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("META_API_KEY");
  });

  it("is stripped from a child env, a CLI probe env and any Windows spelling", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", META_API_KEY: META_KEY };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
    const probe: Record<string, string | undefined> = { PATH: "/usr/bin", META_API_KEY: META_KEY };
    stripCliProbeCredentialEnv(probe);
    expect(probe).toEqual({ PATH: "/usr/bin" });
    const folded: Record<string, string | undefined> = { Path: "p", Meta_Api_Key: META_KEY };
    stripWorkspaceCredentialEnv(folded, "win32");
    expect(folded).toEqual({ Path: "p" });
  });

  describe("another engine's child (fake ACP CLI)", () => {
    let instance: ProviderInstance | undefined;
    let recorder: EventRecorder | undefined;
    let scratch: string;
    beforeEach(() => {
      ensureDirs();
      chmodSync(FAKE_CLI, 0o755);
      scratch = mkdtempSync(join(tmpdir(), "murage-muse-wiring-test-"));
    });
    afterEach(async () => {
      delete process.env.FAKE_ACP_DUMP;
      delete process.env.META_API_KEY;
      recorder?.stop();
      await instance?.dispose();
      instance = undefined;
      await removeTempDir(scratch);
    });

    it("never inherits META_API_KEY from Murage's own environment", async () => {
      process.env.META_API_KEY = META_KEY;
      const dump = join(scratch, "dump.json");
      process.env.FAKE_ACP_DUMP = dump;
      instance = await CustomAcpDriver.create({ instanceId: "custom-muse-wiring", displayName: "Custom", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
      recorder = recordEvents(instance.adapter);
      await instance.adapter.sendTurn({ threadId: "t-muse-wiring", text: "hi" });
      expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
      const seen = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string | undefined> };
      expect(seen.env.META_API_KEY).toBeUndefined();
    });
  });
});

describe("Muse Code on Cloud and Flux", () => {
  const cfg = { instances: { fuigo: { driver: "fuigoAgent" }, muse: { driver: "museCode" } } } as unknown as AppConfig;

  it("is hidden on a Cloud home and listed on the desktop", () => {
    expect(CLOUD_HIDDEN_ENGINES).toContain("museCode");
    expect(isCloudHiddenEngine("museCode")).toBe(true);
    expect(Object.values(instanceConfigs(cfg, { MURAGE_CLOUD_ROLE: "home" })).map((entry) => entry.driver)).not.toContain("museCode");
    expect(Object.values(instanceConfigs(cfg, {})).map((entry) => entry.driver)).toContain("museCode");
    expect(Object.values(instanceConfigs({} as AppConfig, { MURAGE_CLOUD_ROLE: "home" })).map((entry) => entry.driver)).not.toContain("museCode");
  });

  it("never routes through Flux", () => {
    expect(fluxSurfaceFor("museCode")).toBeNull();
  });
});

describe("Muse Code in the engine lists", () => {
  it("is a default instance after Cline, with Fuigo first", () => {
    const keys = Object.keys(DEFAULT_INSTANCES);
    expect(keys[0]).toBe("fuigo");
    expect(DEFAULT_INSTANCES.muse).toEqual({ driver: "museCode" });
    expect(keys.indexOf("muse")).toBe(keys.indexOf("cline") + 1);
    expect(allInstanceConfigs({} as AppConfig).muse?.driver).toBe("museCode");
  });

  it("is registered after Cline, with Fuigo first", () => {
    const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
    expect(kinds[0]).toBe("fuigoAgent");
    expect(kinds.indexOf("museCode")).toBe(kinds.indexOf("clineAgent") + 1);
  });

  it("is named in the primer, deletion and phone-jobs tables", () => {
    // The primer's ENGINE_LABELS is module-private; scripts/build-capability-db.mjs reads it by source the same way.
    const primer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "capabilities-primer.ts"), "utf8");
    expect(primer).toMatch(/const ENGINE_LABELS[^=]*= \{[\s\S]*?\n  museCode: "Muse Code",[\s\S]*?\n\};/);
    expect(ENGINE_LABEL.museCode).toBe("Muse Code");
    expect(PHONE_JOBS_ENGINES.museCode).toBeDefined();
    expect(driverMountsPhoneJobs("museCode")).toBe(true);
  });

  it("signs in with muse login in a terminal and only names its own config home", () => {
    expect(ENGINE_SIGNIN_TABLE.museCode).toMatchObject({ kind: "terminal", args: ["login"], accountKeys: ["XDG_CONFIG_HOME"] });
  });

  it.skipIf(process.platform !== "win32")("finds Muse Code installed after launch on Windows", () => {
    const previous = process.env.LOCALAPPDATA;
    const localAppData = mkdtempSync(join(tmpdir(), "murage-localappdata-"));
    try {
      process.env.LOCALAPPDATA = localAppData;
      const museDir = join(localAppData, "Programs", "muse");
      mkdirSync(museDir, { recursive: true });
      resetPathCacheForTests();
      expect(augmentedPath().split(delimiter)).toContain(museDir);
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
      resetPathCacheForTests();
    }
  });
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
