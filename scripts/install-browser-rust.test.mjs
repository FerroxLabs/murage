// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { installBrowserRust, rustComponents, RUST_INPUTS, RUST_HOSTS } from "./install-browser-rust.mjs";
import { VENDOR_TARGETS } from "./build-browser-vendor.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const manifest = Buffer.from("official manifest fixture"), archive = Buffer.from("verified component fixture");
  const pin = { hosts: ["host"], manifest: { url: "https://fixture.example/manifest", sha256: digest(manifest) }, components: {} };
  for (const key of ["rustc/host", "cargo/host", "rust-std/host", "rust-std/cross"]) {
    pin.components[key] = { url: `https://fixture.example/${key}`, sha256: digest(archive) };
  }
  return { pin, manifest, archive };
}

it.each(["manifest", "component"])("refuses a corrupt %s before running any installer", async corrupt => {
  const root = mkdtempSync(join(tmpdir(), "rust-pin-test-")), f = fixture();
  let executed = false;
  try {
    await expect(installBrowserRust({ host: "host", target: "cross", directory: join(root, "new"), pin: f.pin,
      fetchImpl: async url => new Response(url.endsWith("manifest") ? (corrupt === "manifest" ? "bad" : f.manifest) : "bad"),
      run: () => { executed = true; return { status: 0 }; },
    })).rejects.toThrow("SHA-256");
    expect(executed).toBe(false);
    if (corrupt === "manifest") expect(existsSync(join(root, "new"))).toBe(false);
  } finally { removeTempDirSync(root); }
});

it("installs the verified host closure plus the cross standard library into one isolated prefix", async () => {
  const root = mkdtempSync(join(tmpdir(), "rust-pin-test-")), f = fixture(), calls = [], urls = [];
  try {
    const prefix = await installBrowserRust({ host: "host", target: "cross", directory: join(root, "new"), pin: f.pin,
      fetchImpl: async url => { urls.push(url); return new Response(url.endsWith("manifest") ? f.manifest : f.archive); },
      run: (file, args, options) => {
        calls.push({ file, args, options });
        if (file === "tar") mkdirSync(join(args.at(-1), "component"));
        return { status: 0 };
      },
    });
    expect(urls).toHaveLength(5);
    expect(calls.filter(row => row.file === "bash")).toHaveLength(4);
    for (const call of calls.filter(row => row.file === "bash")) {
      expect(call.args).toEqual(["install.sh", `--prefix=${prefix}`, "--disable-ldconfig"]);
      expect(call.options.shell).toBe(false);
    }
  } finally { removeTempDirSync(root); }
});

it("covers all workflow hosts and cross targets with the official dated component hashes and removes network rustup installs", () => {
  for (const host of Object.values(RUST_HOSTS)) {
    for (const { rust } of Object.values(VENDOR_TARGETS)) {
      const components = rustComponents(host, rust);
      expect(components.length).toBe(host === rust ? 3 : 4);
      for (const component of components) {
        expect(component.url).toContain(`https://static.rust-lang.org/dist/${RUST_INPUTS.manifest.date}/`);
        expect(component.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  }
  expect(() => rustComponents("unknown", "x86_64-unknown-linux-gnu")).toThrow("Unsupported");
  const text = readFileSync(new URL("../.github/workflows/build-browser-vendor.yml", import.meta.url), "utf8");
  const steps = parse(text).jobs.build.steps;
  expect(steps.some(step => step.run?.includes("node scripts/install-browser-rust.mjs"))).toBe(true);
  expect(text).not.toMatch(/rustup (?:toolchain install|target add|default)/);
});
