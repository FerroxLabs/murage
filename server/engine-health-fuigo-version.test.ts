// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HEALTH-DOCTOR-FUIGO-VERSION (1.0.18): Health names the Fuigo actually installed, read from its install receipt (else
// what the engine reports), never a pinned or qualified number.
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { engineHealthRoute, ENGINE_HEALTH_PATH, type EngineHealthInstance } from "./engine-health-routes.ts";
import { installedFuigoVersion } from "./engine-management.ts";
import { QUALIFIED_FUIGO_VERSION } from "./fuigo-native-update.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

/** A managed install's receipt, laid out as stageNativeFuigo leaves it: <root>/fuigo/<id>/<version>-<hex>/{fuigo,manifest.json}. */
async function receipt(version: string, id = "fuigo"): Promise<{ root: string; cli: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "murage-fuigo-version-")));
  roots.push(root);
  const dir = join(root, "fuigo", id, `${version}-0a1b2c`);
  await mkdir(dir, { recursive: true });
  const cli = join(dir, "fuigo");
  await writeFile(cli, "binary");
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ schema: 1, instanceId: id, version, binarySha256: "a".repeat(64),
    proof: { version, protocolVersion: 1, loadSession: true, sessionCreated: true } }));
  return { root, cli };
}

const fuigo: EngineHealthInstance = { instanceId: "fuigo", displayName: "Fuigo", driverKind: "fuigoAgent", snapshot: { state: "available", version: "fuigo 1.0.12 (abc)" } };
const url = new URL(`http://127.0.0.1${ENGINE_HEALTH_PATH}`);

describe("the Fuigo version Health shows", () => {
  it("is the install receipt's version, whatever this build qualified", async () => {
    for (const version of ["1.0.39", "1.0.41"]) {
      const { root, cli } = await receipt(version);
      expect(version).not.toBe(QUALIFIED_FUIGO_VERSION);
      expect(await installedFuigoVersion(root, { instanceId: "fuigo", cli, snapshot: { version: "fuigo 1.0.12" } })).toBe(version);
    }
  });

  it("falls back to the version the engine reports, without the fuigo prefix, and is null when there is neither", async () => {
    const { root } = await receipt("1.0.39");
    expect(await installedFuigoVersion(root, { instanceId: "fuigo", cli: "/usr/local/bin/fuigo", snapshot: { version: "fuigo 1.0.40 (ba7ad54)" } })).toBe("1.0.40");
    expect(await installedFuigoVersion(root, { instanceId: "fuigo", snapshot: { version: null } })).toBeNull();
  });

  it("rides the engine-health answer for the bundled Fuigo instance only", async () => {
    const { root, cli } = await receipt("1.0.39");
    const base = { owner: true, primaryId: () => "fuigo", fluxKey: () => null, now: () => 1 };
    const seen: string[] = [];
    const answer = await engineHealthRoute({ method: "GET", url }, { ...base, instances: async () => [fuigo],
      fuigoVersion: (instance) => { seen.push(instance.instanceId); return installedFuigoVersion(root, { ...instance, cli }); } });
    expect((answer?.body as { fuigoVersion: string | null }).fuigoVersion).toBe("1.0.39");
    expect(seen).toEqual(["fuigo"]);
    const none = await engineHealthRoute({ method: "GET", url }, { ...base, instances: async () => [{ ...fuigo, driverKind: "claudeAgent" }], fuigoVersion: async () => "1.0.39" });
    expect((none?.body as { fuigoVersion: string | null }).fuigoVersion).toBeNull();
    const broken = await engineHealthRoute({ method: "GET", url }, { ...base, instances: async () => [fuigo], fuigoVersion: async () => { throw new Error("unreadable"); } });
    expect((broken?.body as { fuigoVersion: string | null }).fuigoVersion).toBeNull();
  });
});
