import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachedCliVersion, invalidateCliVersions } from "./cli-version-cache.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let dir = "";
const script = (name: string, version: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(path, 0o755);
  return path;
};
type RunCall = [string, string[]];
const counting = (calls: RunCall[], real = false) => ((cli: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
  calls.push([cli, args]);
  setTimeout(() => cb(null, real ? "9.9.9" : "1.2.3 (fake)", ""), 5);
}) as never;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "clivc-")); invalidateCliVersions(); });
afterEach(() => { removeTempDirSync(dir); invalidateCliVersions(); });

describe("cachedCliVersion", () => {
  it("asks an unchanged binary once, however many callers", async () => {
    const cli = script("engine", "1.2.3");
    const calls: RunCall[] = [];
    const run = counting(calls);
    const first = await Promise.all([cachedCliVersion(cli, process.env, run), cachedCliVersion(cli, process.env, run)]);
    await cachedCliVersion(cli, process.env, run);
    expect(calls).toHaveLength(1);
    expect(first[0].stdout).toContain("1.2.3");
  });
  it("probes again when the binary changes (size or mtime)", async () => {
    const cli = script("engine", "1.2.3");
    const calls: RunCall[] = [];
    const run = counting(calls);
    await cachedCliVersion(cli, process.env, run);
    writeFileSync(cli, `#!/bin/sh\necho "1.2.4 with a longer body"\n`);
    await cachedCliVersion(cli, process.env, run);
    expect(calls).toHaveLength(2);
    const later = new Date(Date.now() + 60_000);
    utimesSync(cli, later, later);
    await cachedCliVersion(cli, process.env, run);
    expect(calls).toHaveLength(3);
  });
  it("keeps a separate answer per environment", async () => {
    const cli = script("engine", "1.2.3");
    const calls: RunCall[] = [];
    const run = counting(calls);
    await cachedCliVersion(cli, { HOME: "/a" }, run);
    await cachedCliVersion(cli, { HOME: "/b" }, run);
    await cachedCliVersion(cli, { HOME: "/a" }, run);
    expect(calls).toHaveLength(2);
  });
  it("rechecks on demand and never holds a failure", async () => {
    const cli = script("engine", "1.2.3");
    const calls: RunCall[] = [];
    const run = counting(calls);
    await cachedCliVersion(cli, process.env, run);
    invalidateCliVersions();
    await cachedCliVersion(cli, process.env, run);
    expect(calls).toHaveLength(2);
    const failing = ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => { calls.push(["f", []]); cb(new Error("nope"), "", ""); }) as never;
    const bad = join(dir, "missing");
    await cachedCliVersion(bad, process.env, failing);
    await cachedCliVersion(bad, process.env, failing);
    expect(calls.filter(([c]) => c === "f")).toHaveLength(2);
  });
});

describe("registry.describeOne", () => {
  it("probes only the engine asked for", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" }, c: { driver: "fake" } });
    const probed: string[] = [];
    for (const [id, { instance }] of fake.created) {
      const original = instance.snapshot.bind(instance);
      instance.snapshot = async () => { probed.push(id); return original(); };
    }
    const one = await registry.describeOne("b");
    expect(one).toMatchObject({ instanceId: "b", driverKind: "fake", snapshot: { state: "available" } });
    expect(probed).toEqual(["b"]);
    expect(await registry.describeOne("missing")).toBeUndefined();
  });
  it("shares one in-flight scan between concurrent callers, but not across a change", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });
    let probes = 0;
    for (const { instance } of fake.created.values()) {
      const original = instance.snapshot.bind(instance);
      instance.snapshot = async () => { probes++; await new Promise(r => setTimeout(r, 10)); return original(); };
    }
    await Promise.all([registry.describe(), registry.describe(), registry.describe({ catalogs: "due" })]);
    expect(probes).toBe(2);
    await registry.describe();
    expect(probes).toBe(4);
  });
});
