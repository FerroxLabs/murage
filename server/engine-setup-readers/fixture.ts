// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realImportFs, type ImportFs } from "../claude-code-import.ts";
import { readEngineSetup, type EngineSetupRead } from "./index.ts";

export const GUIDE = "---\nname: guide\ndescription: Fixture guide\n---\nRead the companion.\n";
export const MARKER = "fixture-only-value";

export function readerFixture() {
  let root: string;
  let home: string;
  const opened: string[] = [];
  const bytes: string[] = [];
  const calls: Array<{ path: string; flags: number }> = [];
  const handles = new Map<number, string>();
  const expand = (path: string) => {
    const match = /^(\/proc\/self\/fd\/\d+)(?:\/(.*))?$/.exec(path);
    return match ? join(realImportFs.readlinkSync(match[1]!), match[2] ?? "") : path;
  };
  const fs: ImportFs = {
    ...realImportFs,
    openSync(path, flags) {
      const absolute = expand(path);
      opened.push(absolute);
      calls.push({ path: absolute, flags });
      const fd = realImportFs.openSync(path, flags);
      handles.set(fd, absolute);
      return fd;
    },
    readSync(...args) {
      bytes.push(handles.get(args[0])!);
      return realImportFs.readSync(...args);
    },
    closeSync(fd) {
      handles.delete(fd);
      realImportFs.closeSync(fd);
    },
  };
  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "engine-reader-"));
    home = join(root, "home");
    mkdirSync(home);
    opened.length = bytes.length = calls.length = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, data: string | Buffer) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, data);
    return absolute;
  };
  return {
    get home() { return home; },
    get root() { return root; },
    opened, bytes, calls, fs, put, expand,
    read(engine: EngineSetupRead["engine"], overrides: Partial<EngineSetupRead> = {}, readerFs = fs, now = Date.now) {
      return readEngineSetup({ engine, home, scope: "both", optedIn: true, ...overrides }, readerFs, now);
    },
  };
}
