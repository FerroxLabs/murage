// SPDX-License-Identifier: AGPL-3.0-or-later
// B2a: Sean's five Cloud engines (Claude Code, Codex, Grok, Kimi, OpenCode) are preinstalled
// pinned, verified, signed out and non-updating, each a single native executable.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const source = (name: string) => readFileSync(new URL(`../../deploy/cloud-home/${name}`, import.meta.url), "utf8");
const build = source("build-image.sh");

// [name, version variable, version, x86_64 sha256, aarch64 sha256, download URL, stage file, install line]
const PINS = [
  ["claude", "2.1.323", "604d29a6869409106b6a1110bdadcc8b72e8654a5a865d23258f938a696e348e", "452dddff140b5caf00a5410333a3d6db82c73ea2dec74b1541fae18e97d47dca",
    "https://downloads.claude.ai/claude-code-releases/$claude_version/$claude_platform/claude", "$stage/claude", 'install -o root -g root -m 0755 "$stage/claude" bin/claude'],
  ["codex", "0.171.0", "01baa2e47809f8597be5b2f8abd4e4dfe3fb5bcb6e504c2fbaaad97056c15e8d", "bcf50b836385e51bd2976ab2bbe92b1b08a1cbe37712eb8dbe378aa78d24871c",
    "https://github.com/openai/codex/releases/download/rust-v$codex_version/codex-$codex_triple.tar.gz", "$stage/codex.tar.gz", 'install -o root -g root -m 0755 "$stage/codex-$codex_triple" bin/codex'],
  ["grok", "1.0.52", "1668414b047e1050a96d25fe17dfc3efe63190fbf66d8cc1c3de8633caf50d11", "fc32410b6883c15a39b9f33ec04a6bfb7d070b383e5dbad7efbc48c787e5050d",
    "https://x.ai/cli/grok-$grok_version-$grok_platform", "$stage/grok", 'install -o root -g root -m 0755 "$stage/grok" bin/grok'],
  ["kimi", "2.2.0", "8ee7405d82958f0a50a3aab0773aba9e01057978bad93ba379eaf89e5b6111af", "db89c9999efcd5cce0ddd87d8857c41028a50b9fa3c1297d31559b1557c14e85",
    "https://code.kimi.com/kimi-code/binaries/$kimi_version/kimi-code-$kimi_target", "$stage/kimi", 'install -o root -g root -m 0755 "$stage/kimi" bin/kimi'],
  ["opencode", "1.19.0", "6bdf946045ebfa5773811d0037c1ca8c8a3831880434289b9e4a40c2f1fe8432", "8481102c5d475013302d2f4766cea02b7390e76e74c146408a8cebe2b7f6778f",
    "https://registry.npmjs.org/$opencode_package/-/$opencode_package-$opencode_version.tgz", "$stage/opencode.tgz", 'install -o root -g root -m 0755 "$stage/opencode/package/bin/opencode" bin/opencode'],
] as const;

it.each(PINS)("pins an exact %s version and a checksum per architecture", (name, version, x64, arm, url) => {
  expect(build).toContain(`${name}_version=${version}\n`);
  expect(build).toContain(`${name}_sha256_by_arch=([x86_64]=${x64} [aarch64]=${arm})`);
  expect(build).toContain(`${name}_sha256=\${${name}_sha256_by_arch[$machine]}`);
  expect(build).toContain(url);
  expect(build).not.toMatch(new RegExp(`${name}[^\\n]*(latest|stable)\\b[^\\n]*\\| *(ba)?sh`));
});

// Each architecture's case arm must name its own artifacts: swapped arms build an image whose checksum check fails.
const ARM_ARTIFACTS = {
  x86_64: ["claude_platform=linux-x64", "codex_triple=x86_64-unknown-linux-musl", "grok_platform=linux-x86_64", "kimi_target=linux-x64", "opencode_package=opencode-linux-x64-baseline"],
  aarch64: ["claude_platform=linux-arm64", "codex_triple=aarch64-unknown-linux-musl", "grok_platform=linux-aarch64", "kimi_target=linux-arm64", "opencode_package=opencode-linux-arm64"],
} as const;

it("names each architecture's release artifact inside its own case arm", () => {
  for (const [arch, names] of Object.entries(ARM_ARTIFACTS)) {
    const arm = new RegExp(`^  ${arch}\\) ([^\\n]*) ;;$`, "m").exec(build)?.[1] ?? "";
    expect(arm, arch).not.toBe("");
    for (const name of names) expect(arm.split(" "), `${arch} arm`).toContain(name);
  }
});

it("keeps the qualification script's x64 Claude and Codex pins and the license inventory digests on the build pins", () => {
  const qualify = source("qualify/engine-start-check.py");
  const licenses = source("LICENSES.md");
  const [claude, codex] = PINS;
  expect(qualify).toContain(`"claudeAgent": ("https://downloads.claude.ai/claude-code-releases/${claude[1]}/linux-x64/claude", "${claude[2]}", None)`);
  expect(qualify).toContain(`"codex": ("https://github.com/openai/codex/releases/download/rust-v${codex[1]}/codex-x86_64-unknown-linux-musl.tar.gz", "${codex[2]}", "codex-x86_64-unknown-linux-musl")`);
  expect(licenses).toContain(`| Claude Code | ${claude[1]} (stable channel), https://downloads.claude.ai/claude-code-releases/${claude[1]}/linux-x64/claude; SHA-256 ${claude[2]}`);
  expect(licenses).toContain(`| Codex | ${codex[1]}, https://github.com/openai/codex/releases/tag/rust-v${codex[1]}; codex-x86_64-unknown-linux-musl.tar.gz SHA-256 ${codex[2]}`);
  expect(licenses).toContain(`| Claude Code ${claude[1]} | linux-arm64/claude ${claude[3]} |`);
  expect(licenses).toContain(`| Codex ${codex[1]} | codex-aarch64-unknown-linux-musl.tar.gz ${codex[3]} |`);
});

it.each(PINS)("verifies the %s download fatally before installing it", (name, _v, _x, _a, _u, staged, install) => {
  expect(build).toMatch(/^set -euo pipefail$/m);
  const check = build.indexOf(`"$${name}_sha256" "${staged}" | sha256sum -c -`);
  const download = build.indexOf(`-o "${staged}"`);
  expect(download).toBeGreaterThan(0);
  expect(check).toBeGreaterThan(download);
  expect(build.indexOf(install)).toBeGreaterThan(check);
  const extract = build.indexOf(`tar -xzf "${staged}"`);
  if (extract >= 0) expect(extract).toBeGreaterThan(check);
  expect(build).not.toMatch(/sha256sum -c -\s*(\|\||;)\s*(true|:)/);
});

it("takes OpenCode's baseline x64 build, which needs no AVX2, and keeps arm64 as it was", () => {
  expect(build).toMatch(/^  x86_64\) [^\n]* opencode_package=opencode-linux-x64-baseline /m);
  expect(build).toMatch(/^  aarch64\) [^\n]* opencode_package=opencode-linux-arm64 /m);
  expect(build).not.toMatch(/opencode_package=opencode-linux-x64 /);
});

it("takes only the native opencode executable out of the npm package", () => {
  expect(build).toContain('tar -xzf "$stage/opencode.tgz" -C "$stage/opencode" package/bin/opencode');
});

it("never runs a vendor install script", () => {
  expect(build).not.toMatch(/(curl|wget)[^\n]*(install\.sh|cursor\.com\/install)|\| *(ba)?sh\b/);
});

it("creates no credentials or config for any CLI at build time", () => {
  expect(build).not.toMatch(/claude (login|auth|config|update)|codex (login|logout)|grok (login|logout)|kimi (login|logout)|opencode auth/);
  expect(build).not.toMatch(/\.claude\.json|\.codex\/auth|\.claude\/settings|\.grok\/auth|kimi-code\/credentials|opencode\/auth\.json/);
});

it("disables updates in the managed policy files", () => {
  expect(JSON.parse(source("managed/claude-settings.json")).env).toMatchObject({ DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1" });
  expect(source("managed/codex-requirements.toml")).toMatch(/^check_for_update_on_startup = false$/m);
});

it("lists all five engines plus Fuigo in the engine manifest with digests", () => {
  const writer = /for engine, path in \[(.*)\]:/.exec(build)?.[1] ?? "";
  const entries = [...writer.matchAll(/\("(\w+)", "([^"]+)"\)/g)].map(m => [m[1], m[2]]);
  expect(Object.fromEntries(entries)).toEqual({
    fuigoAgent: "/opt/murage/bin/fuigo", claudeAgent: "/opt/murage/bin/claude", codex: "/opt/murage/bin/codex",
    grokAgent: "/opt/murage/bin/grok", antigravity: "/opt/murage/bin/agy", kimiAgent: "/opt/murage/bin/kimi", opencodeGo: "/opt/murage/bin/opencode",
  });
  expect(build).toContain('"sha256": hashlib.file_digest(stream, "sha256").hexdigest()');
});

it("records a redistribution row for every preinstalled engine CLI", () => {
  const licenses = source("LICENSES.md");
  for (const row of ["| Claude Code |", "| Codex |", "| Grok Build |", "| Kimi Code |", "| OpenCode |"]) expect(licenses).toContain(row);
  for (const row of ["| Claude Code 2.1.323 |", "| Codex 0.171.0 |", "| Grok Build 1.0.52 |", "| Kimi Code 2.2.0 |", "| OpenCode 1.19.0 |"]) expect(licenses).toContain(row);
});

it("pins Antigravity 1.4.4 to Google's published SHA-512 for both architectures, verified before it is unpacked", () => {
  expect(build).toContain("agy_version=1.4.4\n");
  expect(build).toContain("agy_sha512_by_arch=([x86_64]=7ce149d350344c1046c7b59b6659bcc5d659f351bf3a07c6c085887d93427ceb89d927752e4ccd0844b53ffb91d33d6a49f72835ceb276c7cffdd13cfb8023b8 [aarch64]=7bfc4f7e5e2dda4cd0c536c72cf9725c2918a038028ad11fa4f7f5e57db77e9ff7d6b9beca05cd85618b77dd3e77de64b63629d33e5779f29111390dc53c7aaf)");
  expect(build).toContain("agy_dir=linux-x64 agy_file=cli_linux_x64.tar.gz");
  expect(build).toContain("agy_dir=linux-arm agy_file=cli_linux_arm64.tar.gz");
  const download = build.indexOf('-o "$stage/agy.tar.gz"');
  const check = build.indexOf('"$agy_sha512" "$stage/agy.tar.gz" | sha512sum -c -');
  const extract = build.indexOf('tar -xzf "$stage/agy.tar.gz"');
  expect(download).toBeGreaterThan(0);
  expect(check).toBeGreaterThan(download);
  expect(extract).toBeGreaterThan(check);
  expect(build.indexOf('install -o root -g root -m 0755 "$stage/agy/antigravity" bin/agy')).toBeGreaterThan(extract);
  const licenses = source("LICENSES.md");
  expect(licenses).toContain("| Antigravity CLI |");
  expect(licenses).toContain("| Antigravity CLI 1.4.4 |");
});

it("never uses grep -q pipes", () => {
  expect(build).not.toMatch(/\|\s*grep\s+(-\w*\s+)*-\w*q/);
});

// The captured model-support evidence is for the support-floor builds (the oldest builds that
// carry the models), not the Cloud pins: the pins move to the newest stable and must stay at or
// above the floor the evidence qualifies. The floors and their artifact digests are written out
// here so the evidence file cannot move together with its own record.
const FLOORS = {
  claude: { version: "2.1.292", binarySha256: "a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3" },
  codex: { version: "0.162.1", archiveSha256: "86f268d81b898f3e144c5ecff2ad2fda2c5802e042d6195b72538fe0fa125057", binarySha256: "628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1" },
};
const atLeast = (version: string, floor: string) => {
  const a = version.split(".").map(Number), b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

it("captures model support from the exact floor artifacts, gates both engines at those builds, and keeps the pins at or above them", async () => {
  const evidence = JSON.parse(readFileSync(new URL("../../docs/verification/model-defaults-artifacts.json", import.meta.url), "utf8"));
  const { CLAUDE_MIN_VERSION } = await import("../drivers/claude-guards.ts");
  const catalog = readFileSync(new URL("../drivers/codex-catalog.ts", import.meta.url), "utf8");
  const codexFloor = /versionAtLeast\(version, \[(\d+), (\d+), (\d+)\]\)\) throw new CodexCatalogUpdateRequired/.exec(catalog)?.slice(1).join(".");
  expect(evidence.codex.catalogRow).toMatchObject({ slug: "gpt-6.1-sol", visibility: "list", supported_in_api: true });
  expect(evidence.claude.embeddedSourceExcerpt).toContain("claude-sonnet-5-5");
  expect(CLAUDE_MIN_VERSION).toBe(FLOORS.claude.version);
  expect(codexFloor).toBe(FLOORS.codex.version);
  expect(evidence.claude.version).toBe(FLOORS.claude.version);
  expect(evidence.claude.url).toBe(`https://downloads.claude.ai/claude-code-releases/${FLOORS.claude.version}/linux-x64/claude`);
  expect(evidence.claude.binarySha256).toBe(FLOORS.claude.binarySha256);
  expect(evidence.codex.version).toBe(FLOORS.codex.version);
  expect(evidence.codex.url).toBe(`https://github.com/openai/codex/releases/download/rust-v${FLOORS.codex.version}/codex-x86_64-unknown-linux-musl.tar.gz`);
  expect(evidence.codex.archiveSha256).toBe(FLOORS.codex.archiveSha256);
  expect(evidence.codex.binarySha256).toBe(FLOORS.codex.binarySha256);
  expect(atLeast(PINS[0][1], FLOORS.claude.version)).toBe(true);
  expect(atLeast(PINS[1][1], FLOORS.codex.version)).toBe(true);
});
