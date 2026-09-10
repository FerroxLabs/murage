import { afterEach, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { managedFuigoReceipt, nativeFuigoPackage, nativeFuigoTarget, nativeFuigoVersion, probeNativeFuigo, stageNativeFuigo, supportedFuigoVersion, verifyManagedFuigo } from "./fuigo-native-update.ts";
import { nativeFixtureAsset, nativeFixtureBinary } from "./testing/fuigo-native-fixture.ts";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const root = async () => { const path = await mkdtemp(join(tmpdir(), "murage-fuigo-native-")); roots.push(path); return path; };
const proof = (version = "1.0.9") => ({ version, protocolVersion: 1 as const, loadSession: true as const, sessionCreated: true as const });
it("classifies native targets and refuses unqualified release ranges", () => {
  expect(nativeFuigoVersion("fuigo 1.0.9 (ba7ad5430c61)\n")).toBe("1.0.9");
  expect(nativeFuigoVersion("codex 1.0.9")).toBeNull(); expect(nativeFuigoVersion("fuigo 1.0.9 extra")).toBeNull();
  for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]) expect(nativeFuigoTarget(nativeFixtureBinary(target))).toBe(target);
  expect(nativeFuigoTarget(Buffer.from("#!/usr/bin/env node"))).toBeNull();
  for (const version of ["2.0.0", "1.0.8", "latest", "1.0.9;bad", "1.1.0-beta"]) expect(supportedFuigoVersion(version)).toBe(false);
  expect(supportedFuigoVersion("1.0.9")).toBe(true); expect(supportedFuigoVersion("1.2.0")).toBe(true);
});
it("checks tar identity and architecture without extracting archive paths", () => {
  const good = nativeFixtureAsset(); expect(nativeFuigoPackage(good.archive, "darwin-arm64", "1.0.9")).toEqual(good.binary);
  expect(() => nativeFuigoPackage(good.archive, "darwin-arm64", "1.0.10")).toThrow(/identity/);
  expect(() => nativeFuigoPackage(nativeFixtureAsset("1.0.9", "darwin-arm64", "darwin-x64").archive, "darwin-arm64", "1.0.9")).toThrow(/architecture/);
  expect(() => nativeFuigoPackage(Buffer.from("corrupt"), "darwin-arm64", "1.0.9")).toThrow();
});
it("stages verified native bytes and revalidates them before rollback", async () => {
  const directory = await root(), asset = nativeFixtureAsset();
  const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith(".tgz") ? new Response(new Uint8Array(asset.archive)) : Response.json(asset.metadata));
  const probe = vi.fn(async () => proof());
  const cli = await stageNativeFuigo({ root: directory, id: "fuigo", target: "darwin-arm64", version: "1.0.9", fetcher: fetcher as typeof fetch, probe });
  expect(await readFile(cli)).toEqual(asset.binary); expect(probe).toHaveBeenCalledOnce();
  expect(await managedFuigoReceipt(directory, "fuigo", cli)).toMatchObject({ version: "1.0.9", proof: proof() });
  expect(fetcher.mock.calls.every(call => String(call[0]).startsWith("https://registry.npmjs.org/"))).toBe(true);
  await verifyManagedFuigo(directory, "fuigo", cli, "darwin-arm64", probe);
  await writeFile(cli, "corrupt"); await expect(verifyManagedFuigo(directory, "fuigo", cli, "darwin-arm64", probe)).rejects.toThrow(/changed/);
});
it.each(["checksum", "source", "version", "protocol"])("refuses %s failure before producing an activatable candidate", async failure => {
  const directory = await root(), asset = nativeFixtureAsset();
  if (failure === "source") asset.metadata.dist.tarball = "https://untrusted.invalid/native.tgz";
  const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith(".tgz") ? new Response(new Uint8Array(failure === "checksum" ? Buffer.from("changed") : asset.archive)) : Response.json(asset.metadata));
  const probe = vi.fn(async () => failure === "version" ? proof("1.0.8") : failure === "protocol" ? { ...proof(), protocolVersion: 2 as 1 } : proof());
  await expect(stageNativeFuigo({ root: directory, id: "fuigo", target: "darwin-arm64", version: "1.0.9", fetcher: fetcher as typeof fetch, probe })).rejects.toThrow();
  expect(await readdir(join(directory, "fuigo", "fuigo")).catch(() => [])).toEqual([]);
  if (failure === "checksum" || failure === "source") expect(probe).not.toHaveBeenCalled();
});
it.skipIf(process.platform !== "darwin")("probes full ACP through isolated synthetic authentication without owner credentials or prompts", async () => {
  const directory = await root(), cli = join(directory, "fake-native-protocol");
  await writeFile(cli, `#!/bin/sh
test -z "$PATH" || exit 8
test -z "\${FUIGO_API_KEY+x}" || exit 9
test -n "$MURAGE_FUIGO_PROBE_KEY" || exit 12
test "$FUIGO_TELEMETRY_ENABLED" = false || exit 13
if test "$1" = "--version"; then printf 'fuigo 1.0.9 (ba7ad5430c61)\\n'; exit 0; fi
case "$*" in *--no-memory*--no-leader*) ;; *) exit 10;; esac
while IFS= read -r line; do
case "$line" in
*initialize*) printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[{"id":"fuigo.api_key"}]}}\\n';;
*authenticate*) printf '{"jsonrpc":"2.0","id":2,"result":{}}\\n';;
*session/new*) printf '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"isolated"}}\\n';;
*) exit 11;;
esac
done
`); await chmod(cli, 0o700); vi.stubEnv("FUIGO_API_KEY", "fake-owner-key-must-not-inherit");
  await expect(probeNativeFuigo(cli, "1.0.9", directory)).resolves.toEqual(proof());
  expect((await readdir(directory)).filter(name => name.startsWith("probe-"))).toEqual([]);
});
it.skipIf(process.platform === "darwin")("refuses an unqualified isolation platform before creating probe state", async () => {
  const directory = await root();
  await expect(probeNativeFuigo("not-executed", "1.0.10", directory)).rejects.toMatchObject({ code: "FUIGO_PROBE_UNQUALIFIED" });
  expect(await readdir(directory)).toEqual([]);
});
it("retains the Windows unqualified guard before any probe state or execution", async () => {
  const directory = await root(), descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    await expect(probeNativeFuigo("must-not-execute.exe", "1.0.10", directory)).rejects.toMatchObject({ code: "FUIGO_PROBE_UNQUALIFIED" });
    expect(await readdir(directory)).toEqual([]);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
it.skipIf(process.platform !== "darwin")("refuses an unexpected request to the synthetic listener and removes probe state", async () => {
  const directory = await root(), cli = join(directory, "fake-native-request");
  await writeFile(cli, ["#!/bin/sh", 'if test "$1" = "--version"; then printf "fuigo 1.0.10\\n"; exit 0; fi',
    'base=$(/usr/bin/sed -n \'s/^base_url = "\\(.*\\)"$/\\1/p\' "$FUIGO_HOME/config.toml")',
    '/usr/bin/curl --silent --max-time 2 -X POST "$base/chat/completions" >/dev/null', "exit 0", ""].join("\n"));
  await chmod(cli, 0o700);
  await expect(probeNativeFuigo(cli, "1.0.10", directory)).rejects.toMatchObject({ code: "FUIGO_INCOMPATIBLE" });
  expect((await readdir(directory)).filter(name => name.startsWith("probe-"))).toEqual([]);
});
it.skipIf(process.platform !== "darwin").each(["missing-auth", "auth-required", "empty-session"])("refuses %s without weakening the full-session gate and removes probe state", async failure => {
  const directory = await root(), cli = join(directory, "fake-native-refusal");
  const init = { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: failure === "missing-auth" ? [] : [{ id: "fuigo.api_key" }] } };
  const auth = failure === "auth-required" ? { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "ignored provider detail" } } : { jsonrpc: "2.0", id: 2, result: {} };
  await writeFile(cli, ["#!/bin/sh", 'if test "$1" = "--version"; then printf "fuigo 1.0.10\\n"; exit 0; fi',
    "while IFS= read -r line; do", 'case "$line" in',
    `*initialize*) printf '%s\\n' '${JSON.stringify(init)}';;`,
    `*authenticate*) printf '%s\\n' '${JSON.stringify(auth)}';;`,
    `*session/new*) printf '%s\\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":""}}';;`,
    "*) exit 11;;", "esac", "done", ""].join("\n"));
  await chmod(cli, 0o700);
  await expect(probeNativeFuigo(cli, "1.0.10", directory)).rejects.toMatchObject({ code: "FUIGO_INCOMPATIBLE", ...(failure === "auth-required" ? { probeMethod: "authenticate", rpcCode: -32000 } : {}) });
  expect((await readdir(directory)).filter(name => name.startsWith("probe-"))).toEqual([]);
});
