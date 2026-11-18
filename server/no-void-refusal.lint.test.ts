// SPDX-License-Identifier: AGPL-3.0-or-later
// G0-SG lint `no-void-refusal` (nativecrash stage 2): a refusal promise is never discarded with `void`. R.close / R.teardown / R.write /
// settleFenced / the lease close are awaited or joined into the owner's teardown list; a `void` hides a rejection or an unconfirmed close
// from the one-closer contract. (Claude's discarded CliWrite rule is enforced in the claude group, G2.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REFUSAL_PROMISE = /\bvoid\s+(?:[\w$.?!]*\b(?:R|fenced|refusal|fencedRefusal|lease)[\w$]*(?:\.[\w$]+)*\.(?:close|write|teardown|settleFenced|reserveWrite|takeClose)\s*\(|(?:refuseFenced|refuseFencedNative|recordFencedRefusal|closeFenced|settleFenced)\s*\()/;
export const voidRefusals = (source: string): string[] =>
  source.split("\n").flatMap((line, i) => REFUSAL_PROMISE.test(line.replace(/\/\/.*$/, "")) ? [`${i + 1}: ${line.trim().slice(0, 120)}`] : []);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "testing") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.(test|lint\.test)\.ts$/.test(name) ? [path] : [];
  });
}

describe("no-void-refusal", () => {
  it("no server source discards a refusal promise with void", () => {
    const hits = sources("server").flatMap(path => voidRefusals(readFileSync(path, "utf8")).map(hit => `${path}:${hit}`));
    expect(hits).toEqual([]);
  });
  it("the rule catches the discarded forms (mutant control)", () => {
    expect(voidRefusals("  void R.close(fallback);")).toHaveLength(1);
    expect(voidRefusals("  void fenced.write(sink);")).toHaveLength(1);
    expect(voidRefusals("  void refuseFencedNative(e);")).toHaveLength(1);
    expect(voidRefusals("  void lease.fencedRefusal.teardown;")).toHaveLength(0);
    expect(voidRefusals("  await R.close(fallback);")).toEqual([]);
    expect(voidRefusals("  void pending.catch(noop); // R.close mentioned")).toEqual([]);
  });
});
