// SPDX-License-Identifier: AGPL-3.0-or-later
// The rendered config itself is the launcher's (engine-render-launcher.test.ts drives it); the
// server keeps only the image's managed policy files and the list of rendered paths.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { cloudManagedTurnPaths } from "./managed-policy.ts";

it("records only confirmed managed policy keys", () => {
  const read = (file: string) => readFileSync(new URL(`../../deploy/cloud-home/${file}`, import.meta.url), "utf8");
  const claude = JSON.parse(read("managed/claude-settings.json"));
  expect(claude).toMatchObject({ allowManagedHooksOnly: true, allowManagedMcpServersOnly: true, enableAllProjectMcpServers: false, env: { DISABLE_UPDATES: "1" } });
  expect(read("managed/codex-requirements.toml")).toContain("check_for_update_on_startup = false");
  expect(read("managed/grok-requirements.toml")).toContain("auto_update = false");
  expect(read("managed/fuigo-requirements.toml")).toBe("fail_closed = true\nallow_managed_hooks_only = true\n[plugins]\nauto_discover = false\n[cli]\nuse_leader = false\n[claude_compat]\nimported = true\n");
  expect(read("managed/fuigo-managed_config.toml")).toBe("# managed by the Murage launcher\n");
});
it("caps Grok at exactly the version the image installs", () => {
  const read = (file: string) => readFileSync(new URL(`../../deploy/cloud-home/${file}`, import.meta.url), "utf8");
  const installed = /^grok_version=(\S+)$/mu.exec(read("build-image.sh"))?.[1];
  const cap = /^maximum_version = "([^"]+)"$/mu.exec(read("managed/grok-requirements.toml"))?.[1];
  expect(installed).toMatch(/^\d+\.\d+\.\d+$/u);
  expect(cap).toBe(installed);
  expect(read("build-image.sh")).toMatch(/bin\/grok --version/u);
});
// Run the real build-image.sh Grok check (extracted verbatim) against a fixture requirements file and a fake grok.
const buildStepLines = () => {
  const lines = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/build-image.sh", import.meta.url)), "utf8").split("\n");
  const start = lines.findIndex(line => line.startsWith("# One source of truth:"));
  const end = lines.findIndex((line, index) => index > start && line.startsWith("# Fuigo's root-owned system tiers"));
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start + 3);
  return lines.slice(start + 1, end);
};
const runStep = (opts: { pin?: string; cap?: string; grok?: string; drop?: number[] }) => {
  const dir = mkdtempSync(join(tmpdir(), "grok-step-"));
  try {
    const toml = join(dir, "requirements.toml"), fake = join(dir, "grok");
    writeFileSync(toml, `maximum_version = "${opts.cap ?? "1.0.52"}"\n`);
    writeFileSync(fake, opts.grok ?? "#!/bin/sh\necho 'grok 1.0.52'\n"); chmodSync(fake, 0o755);
    const body = buildStepLines().filter((_, index) => !(opts.drop ?? []).includes(index)).join("\n")
      .replaceAll("/etc/grok/requirements.toml", toml).replaceAll("/opt/murage/bin/grok", fake);
    try { execFileSync("bash", ["-c", `set -euo pipefail\ngrok_version=${opts.pin ?? "1.0.52"}\n${body}`], { stdio: "pipe" }); return 0; }
    catch (error) { return (error as { status: number }).status; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const EQUALITY = 0, RUN = 1, COMPARE = 2;
it("the build step passes only for a matching cap and a pinned grok that starts and reports the pin", () => {
  expect(buildStepLines().length).toBe(3);
  expect(runStep({})).toBe(0);
  expect(runStep({ cap: "1.0.45" })).toBe(1);
  expect(runStep({ pin: "1.0.60" })).toBe(1);
  expect(runStep({ grok: "#!/bin/sh\nexit 3\n" })).toBe(1);
  expect(runStep({ grok: "#!/bin/sh\necho 'grok 1.0.45'\n" })).toBe(1);
});
it("each build-step line is load-bearing (mutants: drop the equality check, the run, or the version compare)", () => {
  expect(runStep({ cap: "1.0.45", drop: [EQUALITY] })).toBe(0);
  expect(runStep({ grok: "#!/bin/sh\nexit 3\n", drop: [RUN, COMPARE] })).toBe(0);
  expect(runStep({ grok: "#!/bin/sh\necho 'grok 1.0.45'\n", drop: [COMPARE] })).toBe(0);
  expect(runStep({ grok: "#!/bin/sh\necho 'grok 1.0.45'\n", drop: [RUN] })).toBe(1);
});
it("the image downloads the pinned version and checks its sha256 before install", () => {
  const script = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/build-image.sh", import.meta.url)), "utf8");
  expect(script).toContain('curl -fsSL "https://x.ai/cli/grok-$grok_version-$grok_platform"');
  expect(script).toMatch(/^printf '%s  %s\\n' "\$grok_sha256" "\$stage\/grok" \| sha256sum -c -$/mu);
  expect(script).toMatch(/^grok_version=\d+\.\d+\.\d+$/mu);
});

it("lists the rendered paths under each engine home for diagnostics", () => {
  expect(cloudManagedTurnPaths("codex", "/data/engine-homes/codex")).toEqual(["/data/engine-homes/codex/.codex/config.toml"]);
  expect(cloudManagedTurnPaths("pi", "/data/engine-homes/pi")).toEqual([]);
});
