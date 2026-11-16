// SPDX-License-Identifier: AGPL-3.0-or-later
// Native receipt producer owner: scperf-p2. B34 fixture consumer owner: new3-g2d.
import { expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { launchVerificationServer } from "../../../scripts/control-murage.ts";

it("B34's real native addon establishes measured coverage through authenticated absent enrollment", async () => {
  const meter = new URL("../../io-meter.ts", import.meta.url).href;
  const instrumentationSource = `
    const observation = setInterval(async () => {
      const { ioMeterCoverageKnown } = await import(${JSON.stringify(meter)});
      const known = ioMeterCoverageKnown();
      (await import('node:fs')).writeFileSync((await import('node:path')).join(process.env.MURAGE_DATA_DIR, 'coverage-observation.json'), JSON.stringify({known}));
      if (known) clearInterval(observation);
    }, 100);
    observation.unref();
  `;
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  try {
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(join(fixture.info.dataDir, "coverage-observation.json"), "utf8")).known; }
      catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    const absence = JSON.parse(readFileSync(join(fixture.info.dataDir, "sentinel-io", "absence.json"), "utf8"));
    expect(absence.phase).toBe("absent");
    const evidence = process.env.SC_ISSUES_EVIDENCE;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      const coverage = JSON.parse(readFileSync(join(fixture.info.dataDir, "coverage-observation.json"), "utf8"));
      writeFileSync(join(evidence, "native-coverage-observation.json"), JSON.stringify({ known: coverage.known, absencePhase: absence.phase }));
    }
  } finally { await fixture.close(); }
}, 45_000);

it("Sentinel uses the real fixture addon only in test mode", () => {
  const meter = new URL("../../sentinel/io-meter.ts", import.meta.url).href;
  const source = `
    const { createRequire } = await import('node:module');
    const { scannerNative } = await import(${JSON.stringify(meter)});
    const selected = scannerNative();
    const fixture = createRequire(import.meta.url)(process.env.MURAGE_ENGINE_EXCLUSION_PATH);
    process.stdout.write(JSON.stringify({ usesFixture: selected === fixture }));
  `;
  const selected = (mode: string, extra: NodeJS.ProcessEnv = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: mode };
    delete env.MURAGE_PACKAGED; delete env.MURAGE_RESOURCES_PATH; delete env.OMB_RESOURCES_PATH;
    return JSON.parse(execFileSync(process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source],
      { env: { ...env, ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  };
  expect(selected("test")).toEqual({ usesFixture: true });
  expect(selected("production")).toEqual({ usesFixture: false });
  expect(selected("test", { MURAGE_PACKAGED: "1" })).toEqual({ usesFixture: false });
  const resources = join(process.env.HOME!, "unavailable-fixture-resources");
  expect(selected("test", { MURAGE_RESOURCES_PATH: resources })).toEqual({ usesFixture: false });
  expect(selected("test", { OMB_RESOURCES_PATH: resources })).toEqual({ usesFixture: false });
  expect(selected("test", { MURAGE_RESOURCES_PATH: "", OMB_RESOURCES_PATH: resources })).toEqual({ usesFixture: false });
});
