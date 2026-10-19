// SPDX-License-Identifier: AGPL-3.0-or-later
// The rendered config itself is the launcher's (engine-render-launcher.test.ts drives it); the
// server keeps only the image's managed policy files and the list of rendered paths.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { cloudManagedTurnPaths } from "./managed-policy.ts";

it("records only confirmed managed policy keys", () => {
  const read = (file: string) => readFileSync(new URL(`../../deploy/cloud-home/${file}`, import.meta.url), "utf8");
  const claude = JSON.parse(read("managed/claude-settings.json"));
  expect(claude).toMatchObject({ allowManagedHooksOnly: true, allowManagedMcpServersOnly: true, enableAllProjectMcpServers: false, env: { DISABLE_UPDATES: "1" } });
  expect(read("managed/codex-requirements.toml")).toContain("check_for_update_on_startup = false");
  expect(read("managed/grok-requirements.toml")).toContain('maximum_version = "1.0.45"');
  expect(read("managed/fuigo-requirements.toml")).toBe("[plugins]\nauto_discover = false\n[cli]\nuse_leader = false\n[claude_compat]\nimported = true\n");
  expect(read("managed/fuigo-managed_config.toml")).toBe("# managed by the Murage launcher\n");
});
it("lists the rendered paths under each engine home for diagnostics", () => {
  expect(cloudManagedTurnPaths("codex", "/data/engine-homes/codex")).toEqual(["/data/engine-homes/codex/.codex/config.toml"]);
  expect(cloudManagedTurnPaths("pi", "/data/engine-homes/pi")).toEqual([]);
});
