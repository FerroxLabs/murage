// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Binds the committed WhatsApp runtime pin (runtime-pin.json) to the committed
// package.json and pnpm-lock.yaml, and, when `pnpm build:server` has staged
// dist-server, to the staged runtime and its licence inventory
// (WHATSAPP-DESIGN.md 1.3, 1.4, 9). Shaped like Wayland's
// whatsappBridgeSourcePin.test.ts: drift fails here in seconds, not in a
// packaged build.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const pin = JSON.parse(readFileSync(join(here, "runtime-pin.json"), "utf8")) as {
  contract: string;
  packages: Record<string, { version: string; integrity: string }>;
  bridge: { entry: string; output: string; format: string; external: string[]; maxBytes: number };
};
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
const manifestPath = join(root, "dist-server", "whatsapp-runtime-manifest.json");
const staged = existsSync(manifestPath);

/** Licences a staged package may declare. GPL-3.0 is allowed for libsignal only. */
export const LICENSE_ALLOWLIST = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0", "Zlib"]);
const GPL_ONLY_FOR = new Map([["libsignal", new Set(["GPL-3.0", "GPL-3.0-only", "GPL-3.0-or-later"])]]);

/** True when an SPDX expression ("A OR B", "A AND B", parentheses) is allowed for `name`. */
export function licenseAllowed(name: string, expression: string | null): boolean {
  if (!expression) return false;
  const ok = (id: string) => LICENSE_ALLOWLIST.has(id) || (GPL_ONLY_FOR.get(name)?.has(id) ?? false);
  return expression
    .replace(/[()]/g, " ")
    .split(/\s+AND\s+/)
    .every((group) => group.split(/\s+OR\s+/).some((id) => ok(id.trim())));
}

function lockIntegrity(name: string, version: string): string | undefined {
  const escaped = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`^ {2}'?${escaped}'?:\\n {4}resolution: \\{integrity: (sha512-[^,}]+)`, "m").exec(lock)?.[1];
}

describe("WhatsApp runtime pin (committed sources)", () => {
  it("declares the expected contract", () => {
    expect(pin.contract).toBe("murage-whatsapp-runtime-pin/1.0");
  });

  it("pins baileys and jimp exactly in package.json", () => {
    expect(pkg.dependencies.baileys).toBe("7.0.0-rc14");
    expect(pkg.dependencies.baileys).toBe(pin.packages.baileys.version);
    expect(pkg.dependencies.jimp).toBe(pin.packages.jimp.version);
    expect(pkg.dependencies.jimp).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("never depends on the legacy package, sharp or ffmpeg directly", () => {
    for (const forbidden of ["@whiskeysockets/baileys", "sharp", "fluent-ffmpeg", "ffmpeg-static"]) {
      expect(pkg.dependencies[forbidden]).toBeUndefined();
    }
  });

  it("is at or past the CVE-2026-48063 fix (7.0.0-rc12)", () => {
    const rc = Number(/^7\.0\.0-rc(\d+)$/.exec(pin.packages.baileys.version)?.[1]);
    expect(rc).toBeGreaterThanOrEqual(12);
  });

  it.each(Object.entries(pin.packages))("pnpm-lock.yaml resolves %s at the pinned version and integrity", (name, expected) => {
    expect(lockIntegrity(name, expected.version)).toBe(expected.integrity);
  });

  it("marks baileys's sharp peer optional so it is never installed on its behalf", () => {
    expect(workspace).toMatch(/packageExtensions:\s*\n\s+baileys@7\.0\.0-rc14:\s*\n\s+peerDependenciesMeta:\s*\n\s+sharp:\s*\n\s+optional: true/);
  });

  it("licence allowlist accepts SPDX expressions and confines GPL-3.0 to libsignal", () => {
    expect(licenseAllowed("x", "MIT")).toBe(true);
    expect(licenseAllowed("x", "(MIT OR GPL-3.0)")).toBe(true);
    expect(licenseAllowed("x", "MIT AND ISC")).toBe(true);
    expect(licenseAllowed("x", "GPL-3.0")).toBe(false);
    expect(licenseAllowed("x", "MIT AND GPL-3.0")).toBe(false);
    expect(licenseAllowed("libsignal", "GPL-3.0")).toBe(true);
    expect(licenseAllowed("x", null)).toBe(false);
    expect(licenseAllowed("x", "UNLICENSED")).toBe(false);
  });
});

describe("WhatsApp bridge build wiring (committed sources)", () => {
  const bundler = readFileSync(join(root, "scripts", "bundle-server.mjs"), "utf8");
  const proxies = readFileSync(join(root, "server", "proxy-paths.ts"), "utf8");

  it("builds the bridge with its own ESM esbuild call, baileys and jimp external", () => {
    const call = bundler.slice(bundler.indexOf("const WHATSAPP_ENTRY_POINTS"), bundler.indexOf('await import("./stage-whatsapp-runtime.mjs")'));
    expect(call).toContain("channels/whatsapp/bridge.ts");
    expect(call).toContain(`format: "${pin.bridge.format}"`);
    expect(call).toContain(`external: ${JSON.stringify(pin.bridge.external).replace(/,/g, ", ")}`);
    expect(call).toContain("__harnessRequire");
  });

  it("keeps the bridge out of ENTRY_POINTS, whose build would inline Baileys", () => {
    const entries = bundler.slice(bundler.indexOf("const ENTRY_POINTS = ["), bundler.indexOf("];", bundler.indexOf("const ENTRY_POINTS = [")));
    expect(entries).not.toContain("whatsapp");
    expect(bundler).toContain('external: ["@huggingface/transformers"]');
  });

  it("lists the bridge among the spawned proxies so the packaged smoke checks it exists", () => {
    expect(proxies).toContain('whatsappBridge: resolveProxy("channels/whatsapp/bridge")');
  });
});

describe.skipIf(!staged)("staged WhatsApp runtime (needs pnpm build:server)", () => {
  const manifest = staged
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { packages: { name: string; version: string; license: string | null; path: string }[] })
    : { packages: [] };

  it.each(Object.entries(pin.packages))("stages %s at exactly the pinned version", (name, expected) => {
    const versions = manifest.packages.filter((p) => p.name === name).map((p) => p.version);
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions)).toEqual(new Set([expected.version]));
  });

  it("stages baileys and jimp at the top level of dist-server/node_modules", () => {
    for (const name of ["baileys", "jimp"]) {
      const dir = join(root, "dist-server", "node_modules", name);
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe(pin.packages[name].version);
    }
  });

  it("does not stage sharp", () => {
    expect(manifest.packages.filter((p) => p.name === "sharp")).toEqual([]);
    expect(existsSync(join(root, "dist-server", "node_modules", "baileys", "node_modules", "sharp"))).toBe(false);
  });

  it("every staged package declares an allowed licence", () => {
    const bad = manifest.packages.filter((p) => !licenseAllowed(p.name, p.license)).map((p) => `${p.name}@${p.version}: ${p.license}`);
    expect(bad).toEqual([]);
  });

  it("records the bridge bundle and the staged file still hashes to the record", () => {
    const record = (manifest as unknown as { bridge: { path: string; bytes: number; sha256: string; external: string[] } | null }).bridge;
    expect(record).not.toBeNull();
    expect(record!.path.replace(/\\/g, "/")).toBe(pin.bridge.output);
    expect(record!.external).toEqual(pin.bridge.external);
    const bytes = readFileSync(join(root, "dist-server", pin.bridge.output));
    expect(bytes.length).toBe(record!.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(record!.sha256);
  });

  it("the bridge bundle imports only baileys, jimp and Node built-ins, and does not inline Baileys", () => {
    const text = readFileSync(join(root, "dist-server", pin.bridge.output), "utf8");
    expect(Buffer.byteLength(text)).toBeLessThan(pin.bridge.maxBytes);
    const specifiers = new Set<string>();
    for (const match of text.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(match[1] ?? match[2] ?? match[3]);
    const allowed = new Set(pin.bridge.external);
    const stray = [...specifiers].filter((name) => !name.startsWith("node:") && !allowed.has(name));
    expect(stray).toEqual([]);
    expect(specifiers.has("baileys")).toBe(true);
  });
});
