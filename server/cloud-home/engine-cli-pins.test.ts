// SPDX-License-Identifier: AGPL-3.0-or-later
// B2a: Sean's five Cloud engines (Claude Code, Codex, Grok, Kimi, OpenCode) are preinstalled
// pinned, verified, signed out and non-updating, each a single native executable.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const source = (name: string) => readFileSync(new URL(`../../deploy/cloud-home/${name}`, import.meta.url), "utf8");
const build = source("build-image.sh");

// [name, version variable, version, x86_64 sha256, aarch64 sha256, download URL, stage file, install line]
const PINS = [
  ["claude", "2.1.292", "a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3", "24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0",
    "https://downloads.claude.ai/claude-code-releases/$claude_version/$claude_platform/claude", "$stage/claude", 'install -o root -g root -m 0755 "$stage/claude" bin/claude'],
  ["codex", "0.162.1", "86f268d81b898f3e144c5ecff2ad2fda2c5802e042d6195b72538fe0fa125057", "bf3ca2719f1143b1440fbd85c149379e696c782c50ad7991f8bfcec60b2600c1",
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

it("names each architecture's release artifact", () => {
  for (const name of ["claude_platform=linux-x64", "claude_platform=linux-arm64", "codex_triple=x86_64-unknown-linux-musl", "codex_triple=aarch64-unknown-linux-musl",
    "grok_platform=linux-x86_64", "grok_platform=linux-aarch64", "kimi_target=linux-x64", "kimi_target=linux-arm64",
    "opencode_package=opencode-linux-x64-baseline", "opencode_package=opencode-linux-arm64"]) expect(build).toContain(name);
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
  for (const row of ["| Claude Code 2.1.292 |", "| Codex 0.162.1 |", "| Grok Build 1.0.52 |", "| Kimi Code 2.2.0 |", "| OpenCode 1.19.0 |"]) expect(licenses).toContain(row);
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
