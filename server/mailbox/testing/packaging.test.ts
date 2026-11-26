import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const { getFileMatchers, getMainFileMatchers } = builderRequire("app-builder-lib/out/fileMatcher.js");
const platformConfigs = ["linux", "mac", "win"] as const;
const instrument = /(?:^|[\\/])(?:mailbox[\\/]testing[\\/]|(?:durable-write-gate|commit-gate|crash-child|recorder-proxy|greeter)\.[cm]?[jt]s$)/;

test("H3a the compiled server carries no test instrument", () => {
  const out = mkdtempSync(join(tmpdir(), "mail-package-"));
  try {
    const compiler = require.resolve("typescript/bin/tsc");
    const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.server.build.json", "--outDir", out, "--noCheck"], {
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const emitted = readdirSync(out, { recursive: true, encoding: "utf8" });
    expect(emitted.some(path => /(?:^|[\\/])index\.js$/.test(path))).toBe(true);
    expect(emitted.filter(path => instrument.test(path))).toEqual([]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("H3b the packaged shell and resources carry no test instrument", () => {
  const root = process.cwd();
  const config = parse(readFileSync(join(root, "electron-builder.yml"), "utf8"));
  const out = join(root, config.directories.output);
  const destination = join(out, "fixture");
  const macroExpander = (text: string) => text;
  expect(existsSync(join(root, "test/mailbox/durable-write-gate.mjs"))).toBe(true);
  for (const platform of platformConfigs) {
    const customBuildOptions = config[platform] ?? {};
    const packager = { info: { projectDir: root, buildResourcesDir: config.directories.buildResources, config, debugLogger: { isEnabled: false } } };
    const matchers = [
      ...getMainFileMatchers(root, destination, macroExpander, customBuildOptions, packager, out, false),
      ...(getFileMatchers(config, "extraResources", destination, {
        macroExpander, customBuildOptions, defaultSrc: root, globalOutDir: out,
      }) ?? []),
    ];
    const selected = new Set<string>();
    for (const matcher of matchers) {
      if (!existsSync(matcher.from)) continue;
      const filter = matcher.createFilter();
      const visit = (path: string) => {
        const stat = statSync(path, { throwIfNoEntry: false });
        if (!stat || !filter(path, stat)) return;
        if (stat.isDirectory()) {
          for (const entry of readdirSync(path)) visit(join(path, entry));
        } else if (stat.isFile()) selected.add(relative(root, path));
      };
      const from = resolve(matcher.from);
      if (statSync(from).isDirectory()) {
        for (const entry of readdirSync(from)) visit(join(from, entry));
      } else {
        selected.add(relative(root, from));
      }
    }
    expect(selected.has(join("electron", "main.mjs")), platform).toBe(true);
    expect([...selected].filter(path => instrument.test(path)), platform).toEqual([]);
  }
});
