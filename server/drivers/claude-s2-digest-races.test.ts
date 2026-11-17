// Owner: sc-safety (digest and launch identity); CLI admission is owned by the Claude driver.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as qualification from "./claude-s2-qualification.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function artifact() {
  const root = mkdtempSync(join(tmpdir(), "native-identity-")); roots.push(root);
  const file = join(root, "cli"), bytes = Buffer.from("\x7fELFfixture-native");
  writeFileSync(file, bytes);
  const receipt = { platform: process.platform, arch: process.arch, version: "0.0.1", build: createHash("sha256").update(bytes).digest("hex"), evidence: "isolated-native-receipt" };
  return { root, file, bytes, receipt };
}
it("A-F3e native digest refuses a symlink descriptor", async () => {
  const { root, file } = artifact(), link = join(root, "link"); symlinkSync(file, link);
  expect(await qualification.claudeS2NativeBuild(link)).toBeNull();
});
it("A-F3f invalidation during a hash discards the result and launch identity rejects rename-over", async () => {
  const { root, file, receipt } = artifact();
  const api = qualification as typeof qualification & {
    invalidateClaudeS2NativeBuild?: (file: string) => void;
    claudeS2QualifiedCliNow?: (...args: Parameters<typeof qualification.claudeS2QualifiedCli>) => boolean;
  };
  expect(api.invalidateClaudeS2NativeBuild).toBeTypeOf("function");
  expect(api.claudeS2QualifiedCliNow).toBeTypeOf("function");
  const pending = qualification.prepareClaudeS2NativeBuild(file);
  api.invalidateClaudeS2NativeBuild!(file);
  expect(await pending).toBeNull();
  expect(api.claudeS2QualifiedCliNow!(file, receipt.version, {}, receipt.platform, receipt.arch, [receipt])).toBe(false);
  await qualification.prepareClaudeS2NativeBuild(file);
  expect(api.claudeS2QualifiedCliNow!(file, receipt.version, {}, receipt.platform, receipt.arch, [receipt])).toBe(true);
  const replacement = join(root, "replacement"); writeFileSync(replacement, "\x7fELFother-native"); renameSync(replacement, file);
  expect(api.claudeS2QualifiedCliNow!(file, receipt.version, {}, receipt.platform, receipt.arch, [receipt])).toBe(false);
});

it("A-F3e rename-over between descriptor stats discards the digest", async () => {
  const { root, file } = artifact();
  const fsPromises = await import("node:fs/promises");
  const probe = await fsPromises.open(file, "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const realStat = prototype.stat;
  let stats = 0;
  const replacement = join(root, "replacement"); writeFileSync(replacement, "\x7fELFother-native");
  const spy = vi.spyOn(prototype, "stat").mockImplementation(async function (this: unknown, ...args: unknown[]) {
    if (++stats === 2) renameSync(replacement, file);
    return Reflect.apply(realStat, this, args);
  });
  try { expect(await qualification.claudeS2NativeBuild(file)).toBeNull(); }
  finally { spy.mockRestore(); }
});
